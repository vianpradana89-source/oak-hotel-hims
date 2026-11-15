/** Real app/JWT/RBAC integration. Disposable oak_minibar_test ONLY; no dotenv reads. */
'use strict';
const crypto=require('crypto');
const run=crypto.randomBytes(6).toString('hex');
let target;
try {
  const u=new URL((process.env.TEST_DATABASE_URL||'').trim());
  target={host:u.hostname,port:Number(u.port),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:decodeURIComponent(u.pathname.slice(1))};
  if(!['postgres:','postgresql:'].includes(u.protocol)||u.search||u.hash||target.host!=='127.0.0.1'||
     target.port!==15434||target.user!=='minibar_test'||target.database!=='oak_minibar_test'||!target.password) throw new Error();
} catch(_) {console.error('SAFETY: TEST_DATABASE_URL tidak sesuai target disposable.');process.exit(1);}
// Block transitive dotenv/config imports before loading the production app.
const dotenv=require('dotenv');dotenv.config=()=>({parsed:{}});dotenv.configDotenv=()=>({parsed:{}});
const dc=require.resolve('dotenv/config');require.cache[dc]={id:dc,filename:dc,loaded:true,exports:{}};
Object.assign(process.env,{DB_HOST:target.host,DB_PORT:String(target.port),DB_USER:target.user,DB_PASSWORD:target.password,
  DB_NAME:target.database,RUN_SCHEMA_INITIALIZATION:'false',JWT_SECRET:crypto.randomBytes(32).toString('hex')});
const {app,pool}=require('../dist/index');
const {generateToken,getUserEffectivePermissions}=require('../dist/domains/auth/authService');
const {setRoleAccess,ACCESS_RESOURCES}=require('../dist/domains/settings/accessControlService');
const http=require('http');
const {setBrandingStorageAdapterForTesting}=require('../dist/domains/propertyBranding/brandingStorageService');
const images=new Map();
setBrandingStorageAdapterForTesting({provider:'local',
  save:async(k,b)=>{images.set(k,Buffer.from(b));},delete:async(k)=>{images.delete(k);},
  exists:async(k)=>images.has(k),read:async(k)=>images.get(k)||null});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ34AAAAASUVORK5CYII=','base64');
const fixtures=[];const keys=[];const failures=[];let passed=0;
function check(label,cond) {if(cond){passed++;console.log('  PASS  '+label);}else{failures.push(label);console.error('  FAIL  '+label);}}
function problem(label,e){failures.push(label+': '+String(e&&e.message||e));console.error('[ERROR] '+failures[failures.length-1]);}
async function identity(c){
  for(const k of ['host','port','user','database'])if(String(pool.options[k])!==String(target[k]))throw new Error('pool.options tidak sesuai: '+k);
  const r=(await c.query('SELECT current_database() AS db,current_user AS usr')).rows[0];
  if(r.db!==target.database||r.usr!==target.user)throw new Error('identitas DB tidak sesuai');
}
async function property(c,label){
  const r=await c.query(`INSERT INTO properties(name,property_code,timezone,currency_code,is_active)
    VALUES($1,$2,'Asia/Jakarta','IDR',TRUE) RETURNING id`,['Discount RBAC '+label+' '+run,crypto.randomBytes(3).toString('hex').toUpperCase()]);
  const f={p:Number(r.rows[0].id),roles:[],users:[],orders:[],preserve:false};fixtures.push(f);return f;
}
function grid(resource,edit){const g={};for(const r of ACCESS_RESOURCES)g[r.key]={view:false,edit:false,delete:false};g[resource]={view:true,edit,delete:false};return g;}
async function makeUser(c,f,label,resource,edit){
  const id=Number((await c.query(`INSERT INTO roles(property_id,name,is_active,is_system_role,is_test_data)
    VALUES($1,$2,TRUE,FALSE,TRUE) RETURNING id`,[f.p,'PayConfig '+label+' '+run])).rows[0].id);f.roles.push(id);
  await setRoleAccess(c,f.p,id,grid(resource,edit),{id:0,name:'Settings fixture',property_id:f.p,is_platform_super_admin:false});
  const username='pcfg_'+label+'_'+run;
  const uid=Number((await c.query(`INSERT INTO users(property_id,role_id,username,email,full_name,is_active,is_test_data,account_status,must_change_password,access_type)
    VALUES($1,$2,$3,$4,$5,TRUE,TRUE,'READY',FALSE,'PMS_STAFF') RETURNING id`,[f.p,id,username,username+'@test.local','Config '+label])).rows[0].id);
  f.users.push(uid);
  return {id:uid,username,token:generateToken({id:uid,property_id:f.p,role_id:id,username,email:username+'@test.local',full_name:'Config '+label,
    role:'Config Fixture',scope:'FULL',account_status:'READY',must_change_password:false,access_type:'PMS_STAFF'})};
}
async function req(port,url,method,token,body,image){
  const headers={...(token?{Authorization:'Bearer '+token}:{})};
  let payload;
  if(image){payload=new FormData();payload.append('qris_image',new Blob([image.bytes],{type:image.mime}),'test.png');}
  else if(body){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
  const r=await fetch('http://127.0.0.1:'+port+url,{method,headers,body:payload,signal:AbortSignal.timeout(15000)});
  const type=r.headers.get('content-type')||'';
  return {status:r.status,type,body:type.includes('application/json')?await r.json():null,bytes:type.startsWith('image/')?Buffer.from(await r.arrayBuffer()):null};
}
async function snapshot(c){
  const ps=fixtures.map(f=>f.p),out={};
  for(const table of ['property_payment_instructions','audit_logs','transactions','pos_settlements','payment_transactions','folio_entries']){
    const rows=(await c.query(`SELECT * FROM ${table} WHERE property_id=ANY($1::int[])`,[ps])).rows;
    out[table]=rows.map(r=>JSON.stringify(r)).sort();
  }
  out.images=Array.from(images.entries()).map(([k,b])=>[k,b.toString('hex')]).sort();return JSON.stringify(out);
}
async function rejected(c,port,url,method,token,body,image,status,code,label){
  const before=await snapshot(c),r=await req(port,url,method,token,body,image);
  check(label+' status/code',r.status===status&&(!code||r.body?.code===code));
  check(label+' state/storage tetap',before===await snapshot(c));
  check(label+' tanpa data konfigurasi/gambar',!r.body?.data&&!r.bytes);
}
async function noFinancial(c,f){
  for(const table of ['pos_orders','transactions','pos_settlements','payment_transactions','folio_entries','transaction_daily_sequences']){
    const n=Number((await c.query(`SELECT COUNT(*) AS n FROM ${table} WHERE property_id=$1`,[f.p])).rows[0].n);
    check('No financial '+f.p+' '+table,n===0);
    if(n){f.preserve=true;console.error('[PRESERVE] property '+f.p+' memiliki artefak '+table);}
  }
}
async function clean(c,f){
  if(f.preserve)return;
  await c.query('BEGIN');
  try{
    // ID collection is property-scoped, including responses that failed to parse.
    const orders=(await c.query('SELECT id FROM pos_orders WHERE property_id=$1',[f.p])).rows.map(r=>Number(r.id));
    f.orders.push(...orders);
    await c.query('DELETE FROM pos_order_items WHERE order_id=ANY($1::int[])',[orders]);
    await c.query('DELETE FROM pos_orders WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM audit_logs WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM pos_menu_items WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM pos_menu_categories WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM user_permission_overrides WHERE property_id=$1 AND user_id=ANY($2::int[])',[f.p,f.users]);
    await c.query('DELETE FROM users WHERE property_id=$1 AND id=ANY($2::int[])',[f.p,f.users]);
    await c.query('DELETE FROM roles WHERE property_id=$1 AND id=ANY($2::int[])',[f.p,f.roles]);
    await c.query('DELETE FROM property_payment_instructions WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM properties WHERE id=$1',[f.p]);
    await c.query('COMMIT');
  }catch(e){try{await c.query('ROLLBACK');}catch(rb){e.discardClient=true;problem('cleanup rollback',rb);}throw e;}
}
async function residue(c){
  const ps=fixtures.map(f=>f.p),roles=fixtures.flatMap(f=>f.roles),orders=fixtures.flatMap(f=>f.orders);
  for(const table of ['pos_orders','audit_logs','transactions','pos_settlements','payment_transactions','folio_entries',
    'transaction_daily_sequences','pos_menu_items','pos_menu_categories','users','roles','user_permission_overrides']){
    check('Residue '+table+'=0',Number((await c.query(`SELECT COUNT(*) AS n FROM ${table} WHERE property_id=ANY($1::int[])`,[ps])).rows[0].n)===0);
  }
  check('Residue payment configuration=0',Number((await c.query('SELECT COUNT(*) AS n FROM property_payment_instructions WHERE property_id=ANY($1::int[])',[ps])).rows[0].n)===0);
  check('Residue properties=0',Number((await c.query('SELECT COUNT(*) AS n FROM properties WHERE id=ANY($1::int[])',[ps])).rows[0].n)===0);
  check('Residue role_permissions=0',Number((await c.query('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=ANY($1::int[])',[roles])).rows[0].n)===0);
  check('Residue pos_order_items=0',Number((await c.query('SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id=ANY($1::int[])',[orders])).rows[0].n)===0);
}
function release(c,label,discard=false){if(c)try{c.release(discard);}catch(e){problem(label+' release',e);}}
async function main(){
  let c=null,server=null,verified=false;
  console.log('[POS PAYMENT SETTINGS TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');
  try{
    c=await pool.connect();await identity(c);verified=true;
    await c.query('SELECT qris_enabled,qris_image_path,transfer_enabled,debit_enabled FROM property_payment_instructions LIMIT 0');
    const perms=(await c.query("SELECT key FROM permissions WHERE key=ANY($1::text[])",[['settings.view','settings.edit','pos.view']])).rows;
    if(perms.length!==3)throw new Error('Settings/POS permissions prerequisite tidak lengkap');
    console.log('[IDENTITY/SCHEMA] terverifikasi.');
    const a=await property(c,'A'),b=await property(c,'B');
    const admin=await makeUser(c,a,'admin','Pengaturan',true),cashier=await makeUser(c,a,'cashier','POS',false),other=await makeUser(c,b,'other','POS',false);
    server=http.createServer(app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    const settings='/api/settings/property/payment-instructions';
    const image=settings+'/qris-image?property_id='+a.p;
    const pos='/api/pos/payment-config?property_id='+a.p;
    const posImage='/api/pos/payment-config/qris-image?property_id='+a.p;
    const initial=await req(port,settings+'?property_id='+a.p,'GET',admin.token);
    check('Pengaturan belum dikonfigurasi: tidak ada rekening/gambar palsu',initial.status===200&&initial.body.data.bank_account_number===null&&
      initial.body.data.qris_image_path===null&&initial.body.data.qris_enabled===false&&initial.body.data.transfer_enabled===false&&initial.body.data.debit_enabled===false);
    check('GET tidak membuat konfigurasi DB',Number((await c.query('SELECT COUNT(*) AS n FROM property_payment_instructions WHERE property_id=$1',[a.p])).rows[0].n)===0);
    const initialPos=await req(port,pos,'GET',cashier.token);
    check('Kasir POS View boleh membaca config tanpa Settings View',initialPos.status===200&&initialPos.body.data.property_id===a.p&&initialPos.body.data.qris_image_available===false);
    await rejected(c,port,pos,'GET',null,null,null,401,null,'Config tanpa JWT');
    await rejected(c,port,pos,'GET',other.token,null,null,403,'PROPERTY_SCOPE_REQUIRED','Config cross-property');
    await rejected(c,port,settings,'PUT',cashier.token,{property_id:a.p,transfer_enabled:true},null,403,'FORBIDDEN','Kasir tidak boleh mengedit pengaturan');
    await rejected(c,port,settings,'PUT',admin.token,{property_id:a.p,qris_enabled:'false'},null,400,'VALIDATION_ERROR','Boolean string ditolak');
    await rejected(c,port,settings,'PUT',admin.token,{property_id:a.p,qris_enabled:true,qris_merchant_id:'MERCHANT'},null,422,'QRIS_NOT_CONFIGURED','Merchant ID tanpa gambar ditolak');
    await rejected(c,port,settings,'PUT',admin.token,{property_id:a.p,transfer_enabled:true},null,422,'TRANSFER_NOT_CONFIGURED','Transfer tanpa rekening ditolak');
    await rejected(c,port,settings,'PUT',admin.token,{property_id:a.p,debit_enabled:true},null,422,'DEBIT_NOT_CONFIGURED','Debit tanpa terminal ditolak');
    await rejected(c,port,settings,'PUT',admin.token,{property_id:a.p,qris_image_path:'/uploads/foreign.png'},null,400,'QRIS_IMAGE_UPLOAD_REQUIRED','Pointer gambar tidak boleh diisi lewat body');
    const upload={bytes:png,mime:'image/png'};
    await rejected(c,port,image,'POST',null,null,upload,401,null,'Upload tanpa JWT');
    await rejected(c,port,image,'POST',cashier.token,null,upload,403,'FORBIDDEN','Kasir tidak boleh upload QRIS');
    await rejected(c,port,settings+'/qris-image?property_id='+b.p,'POST',admin.token,null,upload,403,'PROPERTY_SCOPE_REQUIRED','Upload cross-property');
    await rejected(c,port,image,'POST',admin.token,null,{bytes:Buffer.from('not an image'),mime:'image/png'},400,'INVALID_QRIS_IMAGE','MIME palsu ditolak');
    await rejected(c,port,image,'POST',admin.token,null,{bytes:Buffer.alloc(2*1024*1024+1),mime:'image/png'},400,'QRIS_IMAGE_TOO_LARGE','Upload melebihi 2 MB ditolak');
    const uploaded=await req(port,image,'POST',admin.token,null,upload);
    check('Upload resmi tersimpan, QRIS belum otomatis aktif',uploaded.status===200&&uploaded.body.data.qris_enabled===false);
    const firstKey=uploaded.body?.data?.qris_image_path;if(!firstKey)throw new Error('Key upload tidak tersedia');
    check('Key scoped properti/folder QRIS, satu objek',firstKey.startsWith('branding/'+a.p+'/payment-qris/')&&images.size===1);
    check('Uploaded_by dari auth',uploaded.body.data.updated_by===admin.username);
    const preview=await req(port,image,'GET',admin.token);
    check('Preview settings membaca bytes PNG sebenarnya',preview.status===200&&preview.type.startsWith('image/png')&&preview.bytes?.equals(png));
    const cashPreview=await req(port,posImage,'GET',cashier.token);
    check('Kasir dapat membaca bytes gambar via endpoint POS',cashPreview.status===200&&cashPreview.bytes?.equals(png));
    await rejected(c,port,posImage,'GET',null,null,null,401,null,'Gambar tanpa JWT');
    await rejected(c,port,posImage,'GET',other.token,null,null,403,'PROPERTY_SCOPE_REQUIRED','Gambar cross-property');
    const cfg={property_id:a.p,bank_name:' Bank Test ',bank_account_name:' Property Test ',bank_account_number:' 123456 ',bank_branch:' Branch ',payment_note:' Note ',
      is_active:false,qris_enabled:true,qris_terminal_name:' QR Front ',qris_merchant_id:' MERCHANT ',transfer_enabled:true,transfer_ref_note:' Ref note ',debit_enabled:true,debit_edc_terminal:' EDC Front '};
    const saved=await req(port,settings,'PUT',admin.token,cfg);
    check('Simpan tiga metode berhasil',saved.status===200&&saved.body.data.qris_enabled===true&&saved.body.data.transfer_enabled===true&&saved.body.data.debit_enabled===true);
    check('Snapshot string dinormalisasi, key gambar dipertahankan',saved.body?.data?.bank_account_number==='123456'&&saved.body.data.qris_image_path===firstKey&&saved.body.data.debit_edc_terminal==='EDC Front');
    const returned=await req(port,pos,'GET',cashier.token);
    check('Config POS memuat QRIS displayable/rekening/EDC',returned.status===200&&returned.body.data.qris_image_available===true&&returned.body.data.qris_enabled===true&&
      returned.body.data.bank_account_number==='123456'&&returned.body.data.debit_edc_terminal==='EDC Front');
    check('Toggle instruksi dokumen terpisah dari metode POS',saved.body.data.is_active===false&&returned.body.data.transfer_enabled===true);
    const oldClient={property_id:a.p,bank_name:'Bank Test',bank_account_name:'Property Test',bank_account_number:'123456',bank_branch:'Legacy update',payment_note:'Note',is_active:true};
    const legacy=await req(port,settings,'PUT',admin.token,oldClient);
    check('Klien lama tidak mereset tiga metode/gambar',legacy.status===200&&legacy.body.data.qris_enabled===true&&legacy.body.data.transfer_enabled===true&&
      legacy.body.data.debit_enabled===true&&legacy.body.data.qris_image_path===firstKey&&legacy.body.data.transfer_ref_note==='Ref note');
    const again=await req(port,image,'POST',admin.token,null,upload);
    const secondKey=again.body?.data?.qris_image_path;
    check('Penggantian gambar menghasilkan key baru, objek lama dihapus',again.status===200&&secondKey!==firstKey&&images.has(secondKey)&&!images.has(firstKey)&&images.size===1);
    await rejected(c,port,image,'DELETE',cashier.token,null,null,403,'FORBIDDEN','Kasir tidak boleh menghapus QRIS');
    const deleted=await req(port,image,'DELETE',admin.token);
    check('Hapus QRIS menonaktifkan metode dan menghapus objek',deleted.status===200&&deleted.body.data.qris_image_path===null&&deleted.body.data.qris_enabled===false&&images.size===0);
    check('Hapus QRIS mempertahankan Transfer/Debit/rekening',deleted.body.data.transfer_enabled===true&&deleted.body.data.debit_enabled===true&&deleted.body.data.bank_account_number==='123456');
    const absent=await req(port,posImage,'GET',cashier.token);
    check('Gambar terhapus tidak dapat dibaca',absent.status===404&&absent.body.code==='QRIS_IMAGE_NOT_FOUND');
  }catch(e){problem('main',e);}
  finally{
    if(server)try{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}catch(e){problem('server.close',e);}
    release(c,'main',true);c=null;
    if(verified){for(const f of fixtures){let cc=null,bad=false;
      try{cc=await pool.connect();await identity(cc);await noFinancial(cc,f);await clean(cc,f);
        if(!f.preserve)for(const k of images.keys())if(k.startsWith('branding/'+f.p+'/payment-qris/'))images.delete(k);
      }catch(e){bad=Boolean(e.discardClient);problem('cleanup '+f.p,e);}finally{release(cc,'cleanup',bad);}}
      let rc=null;try{rc=await pool.connect();await identity(rc);await residue(rc);}catch(e){problem('residue',e);}finally{release(rc,'residue');}}
    check('Residue storage fixture=0',images.size===0);setBrandingStorageAdapterForTesting(null);
    try{await pool.end();}catch(e){problem('pool.end',e);}
  }
  console.log('\n[RESULT] '+passed+' PASS, '+failures.length+' FAIL');for(const f of failures)console.error('  - '+f);
  if(!failures.length)console.log('[CLEANUP/RESIDUE] 0 — seluruh fixture bersih.');process.exitCode=failures.length?1:0;
}
main().catch(e=>{console.error('[CRASH]',e.message);process.exitCode=1;});
