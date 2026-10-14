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
function grid(edit){const g={};for(const r of ACCESS_RESOURCES)g[r.key]={view:false,edit:false,delete:false};g.POS={view:true,edit,delete:false};return g;}
async function role(c,f,label,edit,discount){
  const id=Number((await c.query(`INSERT INTO roles(property_id,name,is_active,is_system_role,is_test_data)
    VALUES($1,$2,TRUE,FALSE,TRUE) RETURNING id`,[f.p,'DiscRBAC '+label+' '+run])).rows[0].id);f.roles.push(id);
  await setRoleAccess(c,f.p,id,grid(edit),{id:0,name:'RBAC fixture',property_id:f.p,is_platform_super_admin:false});
  if(discount)await c.query(`INSERT INTO role_permissions(role_id,permission_id,granted,created_by)
    SELECT $1,id,TRUE,'RBAC fixture' FROM permissions WHERE key='pos.discount.edit'`,[id]);
  return id;
}
async function user(c,f,r,label){
  const username='drbac_'+label+'_'+run;
  const row=(await c.query(`INSERT INTO users(property_id,role_id,username,email,full_name,is_active,is_test_data,
    account_status,must_change_password,access_type) VALUES($1,$2,$3,$4,$5,TRUE,TRUE,'READY',FALSE,'PMS_STAFF') RETURNING id`,
    [f.p,r,username,username+'@test.local','RBAC '+label])).rows[0];
  const id=Number(row.id);f.users.push(id);
  const payload={id,property_id:f.p,role_id:r,username,email:username+'@test.local',full_name:'RBAC '+label,
    role:'Fixture',scope:'FULL',account_status:'READY',must_change_password:false,access_type:'PMS_STAFF'};
  return {id,username,role:r,payload,token:generateToken(payload)};
}
async function menu(c,f,label,price){
  const cat=(await c.query('INSERT INTO pos_menu_categories(property_id,name) VALUES($1,$2) RETURNING id',[f.p,'RBAC '+label])).rows[0].id;
  return Number((await c.query('INSERT INTO pos_menu_items(property_id,category_id,name,price,is_active) VALUES($1,$2,$3,$4,TRUE) RETURNING id',
    [f.p,cat,label,price])).rows[0].id);
}
async function state(c){
  const ids=fixtures.map(f=>f.p),data={};
  for(const [table,id]of [['pos_orders','id'],['audit_logs','audit_id'],['transactions','id'],['pos_settlements','id'],
    ['payment_transactions','id'],['folio_entries','id'],['transaction_daily_sequences',null]]){
    const r=(await c.query(`SELECT * FROM ${table} WHERE property_id=ANY($1::int[])`,[ids])).rows;
    data[table]=r.sort((a,b)=>id?String(a[id]).localeCompare(String(b[id])):JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  const items=(await c.query(`SELECT oi.* FROM pos_order_items oi JOIN pos_orders o ON o.id=oi.order_id
    WHERE o.property_id=ANY($1::int[]) ORDER BY oi.id`,[ids])).rows;
  data.items=items;return JSON.stringify(data);
}
async function request(port,body,token,key){
  keys.push(key);
  const r=await fetch('http://127.0.0.1:'+port+'/api/pos/orders',{method:'POST',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json','Idempotency-Key':key,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
async function denied(c,port,body,token,key,status,code,label){
  const before=await state(c),r=await request(port,body,token,key);
  check(label+' status/code',r.status===status&&(!code||r.body.code===code));
  check(label+' tanpa mutation order/item/audit/financial',before===await state(c));
  check(label+' tanpa data order',!r.body.data);
}
async function permission(c,roleId,granted){
  await c.query(`UPDATE role_permissions SET granted=$2 WHERE role_id=$1
    AND permission_id=(SELECT id FROM permissions WHERE key='pos.discount.edit')`,[roleId,granted]);
}
async function noFinancial(c,f){
  for(const table of ['transactions','pos_settlements','payment_transactions','folio_entries','transaction_daily_sequences']){
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
  check('Residue properties=0',Number((await c.query('SELECT COUNT(*) AS n FROM properties WHERE id=ANY($1::int[])',[ps])).rows[0].n)===0);
  check('Residue role_permissions=0',Number((await c.query('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=ANY($1::int[])',[roles])).rows[0].n)===0);
  check('Residue pos_order_items=0',Number((await c.query('SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id=ANY($1::int[])',[orders])).rows[0].n)===0);
  check('Global create cache tidak dipakai',Number((await c.query('SELECT COUNT(*) AS n FROM idempotency_keys WHERE key=ANY($1::text[])',[keys])).rows[0].n)===0);
}
function release(c,label,discard=false){if(c)try{c.release(discard);}catch(e){problem(label+' release',e);}}
async function main(){
  let c=null,server=null,verified=false;
  console.log('[POS DISCOUNT RBAC ENDPOINT TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');
  try{
    c=await pool.connect();await identity(c);
    const required=(await c.query("SELECT key FROM permissions WHERE key=ANY($1::text[])",[['pos.view','pos.create','pos.edit','pos.discount.edit']])).rows.map(r=>r.key);
    if(required.length!==4)throw new Error('Permission prerequisite tidak lengkap');
    verified=true;console.log('[IDENTITY/PERMISSIONS] terverifikasi.');
    const a=await property(c,'A'),b=await property(c,'B');
    const rNo=await role(c,a,'no-discount',true,false),rYes=await role(c,a,'discount',true,true),rView=await role(c,a,'view-with-discount',false,true);
    const rB=await role(c,b,'B-edit',true,true);
    const no=await user(c,a,rNo,'no'),yes=await user(c,a,rYes,'yes'),view=await user(c,a,rView,'view'),other=await user(c,b,rB,'other');
    const m1=await menu(c,a,'RBAC item 1',19500),m2=await menu(c,a,'RBAC item 2',30000);
    const body={property_id:a.p,items:[{menu_item_id:m1,quantity:2,discount_type:'NOMINAL',discount_value:5000},
      {menu_item_id:m2,quantity:1,discount_type:'PERCENT',discount_value:10}],discount_type:'PERCENT',discount_value:10,discount_reason:'RBAC test',
      actor_user_id:999999,actor_name:'BODY-SPOOF',verified_by:'BODY-SPOOF'};
    check('Role POS Edit tidak otomatis memberi diskon',!(await getUserEffectivePermissions(c,no.id)).includes('pos.discount.edit'));
    check('Role grant diskon terbaca resolver produksi',(await getUserEffectivePermissions(c,yes.id)).includes('pos.discount.edit'));
    // Saving the normal access grid must preserve this separate atomic grant.
    await setRoleAccess(c,a.p,rYes,grid(true),{id:0,name:'RBAC fixture',property_id:a.p,is_platform_super_admin:false});
    check('Simpan POS grid mempertahankan izin diskon terpisah',(await getUserEffectivePermissions(c,yes.id)).includes('pos.discount.edit'));
    server=http.createServer(app);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    await denied(c,port,body,null,run+'-notoken',401,null,'Tanpa JWT');
    await denied(c,port,body,no.token,run+'-nogrant',403,'DISCOUNT_PERMISSION_DENIED','POS edit tanpa diskon');
    const forged=generateToken({...no.payload,role:'Super Admin',role_id:rYes,permissions:['pos.discount.edit']});
    await denied(c,port,body,forged,run+'-claims',403,'DISCOUNT_PERMISSION_DENIED','JWT role/permission claims tidak mengganti DB');
    await denied(c,port,{property_id:a.p,items:[body.items[0]]},no.token,run+'-item',403,'DISCOUNT_PERMISSION_DENIED','Diskon item saja');
    await denied(c,port,{property_id:a.p,items:[{menu_item_id:m1,quantity:1}],discount_type:'PERCENT',discount_value:10},
      no.token,run+'-order',403,'DISCOUNT_PERMISSION_DENIED','Diskon order saja');
    await denied(c,port,body,view.token,run+'-view',403,'FORBIDDEN','Diskon tanpa POS Edit');
    await denied(c,port,body,other.token,run+'-cross',403,'PROPERTY_SCOPE_REQUIRED','JWT properti lain');
    const key=run+'-yes';
    const created=await request(port,body,yes.token,key);
    check('Grant nyata: HTTP 201 SUCCESS',created.status===201&&created.body.status==='SUCCESS');
    const orderId=created.body.data&&Number(created.body.data.id);
    if(!orderId)throw new Error('Order granted tidak dibuat');a.orders.push(orderId);
    const order=(await c.query('SELECT * FROM pos_orders WHERE property_id=$1 AND id=$2',[a.p,orderId])).rows[0];
    check('Snapshot OPEN/net/order discount',order.status==='OPEN'&&Number(order.total_amount)===54900&&Number(order.discount_amount)===6100);
    const items=(await c.query('SELECT * FROM pos_order_items WHERE order_id=$1 ORDER BY id',[orderId])).rows;
    check('Snapshot diskon item per LINE',items.length===2&&Number(items[0].quantity)===2&&Number(items[0].discount_amount)===5000&&Number(items[1].discount_amount)===3000);
    const audits=(await c.query("SELECT * FROM audit_logs WHERE property_id=$1 AND action='ORDER_DISCOUNT_APPLIED'",[a.p])).rows;
    check('Satu audit diskon',audits.length===1);
    if(audits.length===1){const av=JSON.parse(audits[0].new_value);
      check('Actor audit dari JWT; body spoof diabaikan',String(audits[0].actor_user_id)===String(yes.id)&&Number(av.actor_user_id)===yes.id&&av.actor_name===yes.username);
      check('Audit total discount/order',av.total_discount===14100&&av.order_discount.discount_amount===6100&&Number(av.pos_order_id)===orderId);
    }
    let before=await state(c);
    const replay=await request(port,body,yes.token,key);
    check('Replay 200/ID sama',replay.status===200&&replay.body.code==='IDEMPOTENT_REPLAY'&&Number(replay.body.data&&replay.body.data.id)===orderId);
    check('Replay tanpa order/item/audit tambahan',before===await state(c));
    await permission(c,rYes,false);
    check('Grant FALSE hilang dari resolver',!(await getUserEffectivePermissions(c,yes.id)).includes('pos.discount.edit'));
    await denied(c,port,body,yes.token,key,403,'DISCOUNT_PERMISSION_DENIED','Revoke: JWT/key replay yang sama ditolak');
    await denied(c,port,body,yes.token,run+'-revoked-new',403,'DISCOUNT_PERMISSION_DENIED','Revoke: order baru ditolak');
    await permission(c,rYes,true);
    before=await state(c);
    const restored=await request(port,body,yes.token,key);
    check('Regrant: JWT sama replay berhasil',restored.status===200&&Number(restored.body.data&&restored.body.data.id)===orderId);
    check('Regrant replay tetap tanpa mutation',before===await state(c));
    const plain=await request(port,{property_id:a.p,items:[{menu_item_id:m1,quantity:2}]},no.token,run+'-plain');
    check('Tanpa izin diskon tetap boleh order normal',plain.status===201&&Number(plain.body.data&&plain.body.data.total_amount)===39000);
    if(plain.body.data&&plain.body.data.id)a.orders.push(Number(plain.body.data.id));
    check('Order normal tidak menambah audit diskon',Number((await c.query("SELECT COUNT(*) AS n FROM audit_logs WHERE property_id=$1 AND action='ORDER_DISCOUNT_APPLIED'",[a.p])).rows[0].n)===1);
    await c.query('UPDATE roles SET is_active=FALSE WHERE id=$1',[rYes]);
    await denied(c,port,body,yes.token,run+'-inactive',403,null,'Role nonaktif dengan JWT lama');
  }catch(e){problem('main',e);}
  finally{
    if(server)try{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}catch(e){problem('server.close',e);}
    release(c,'main',true);c=null;
    if(verified){
      for(const f of fixtures){let cc=null,bad=false;try{cc=await pool.connect();await identity(cc);await noFinancial(cc,f);await clean(cc,f);}
        catch(e){bad=Boolean(e.discardClient);f.preserve=true;problem('cleanup '+f.p,e);}finally{release(cc,'cleanup',bad);}}
      let rc=null;try{rc=await pool.connect();await identity(rc);await residue(rc);}catch(e){problem('residue',e);}finally{release(rc,'residue');}
    }
    try{await pool.end();}catch(e){problem('pool.end',e);}
  }
  console.log('\n[RESULT] '+passed+' PASS, '+failures.length+' FAIL');
  for(const f of failures)console.error('  - '+f);
  if(!failures.length)console.log('[CLEANUP/RESIDUE] 0 — seluruh fixture bersih.');
  process.exitCode=failures.length?1:0;
}
main().catch(e=>{console.error('[CRASH]',e.message);process.exitCode=1;});
