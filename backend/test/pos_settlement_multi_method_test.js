/** PostgreSQL integration checks; disposable oak_minibar_test ONLY. No dotenv. */
'use strict';
const crypto = require('crypto');
let target;
try {
  const u = new URL((process.env.TEST_DATABASE_URL || '').trim());
  target = {host:u.hostname, port:Number(u.port), user:decodeURIComponent(u.username),
    password:decodeURIComponent(u.password), database:decodeURIComponent(u.pathname.slice(1))};
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.search || u.hash ||
      target.host !== '127.0.0.1' || target.port !== 15434 ||
      target.user !== 'minibar_test' || target.database !== 'oak_minibar_test' || !target.password)
    throw new Error('target wajib database/user oak_minibar_test/minibar_test di 127.0.0.1:15434 tanpa query/fragment');
} catch (_) { console.error('SAFETY: TEST_DATABASE_URL tidak ada atau tidak sesuai target disposable.'); process.exit(1); }
const {Pool} = require('pg');
const {setBrandingStorageAdapterForTesting}=require('../dist/domains/propertyBranding/brandingStorageService');
const {savePropertyQrisImage,deletePropertyQrisImage,isPropertyQrisImageKey}=require('../dist/domains/propertyPaymentInstructions/qrisImageStorage');
const qrisImages=new Map();
setBrandingStorageAdapterForTesting({provider:'local',save:async(k,b)=>{qrisImages.set(k,Buffer.from(b));},
  delete:async(k)=>{qrisImages.delete(k);},exists:async(k)=>qrisImages.has(k),read:async(k)=>qrisImages.get(k)||null});
const qrisPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ34AAAAASUVORK5CYII=','base64');
const pool = new Pool({...target, max:4, options:'-c search_path=public'});
const {payPosOrder, payPosOrderCash, computeCashSettlementFingerprint} = require('../dist/domains/pos/posSettlementService');
const {projectPosOrderToTransaction} = require('../dist/domains/transactions/transactionService');
const run = crypto.randomBytes(6).toString('hex');
const fixtures = [];
const failures = [];
let passed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log('  PASS  ' + label); }
  else { failures.push(label); console.error('  FAIL  ' + label); }
}
function problem(label, err) {
  failures.push(label + ': ' + String(err && err.message || err));
  console.error('[ERROR] ' + failures[failures.length - 1]);
}
async function identity(c) {
  for (const field of ['host','port','user','database'])
    if (String(pool.options[field]) !== String(target[field])) throw new Error('pool.options berbeda: ' + field);
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user) throw new Error('identitas DB tidak sesuai');
}
async function schema(c) {
  for (const sql of [
    'SELECT id,property_id,status,total_amount,discount_type,discount_value,discount_amount FROM public.pos_orders LIMIT 0',
    'SELECT id,order_id,menu_item_id,quantity,unit_price,discount_type,discount_value,discount_amount FROM public.pos_order_items LIMIT 0',
    'SELECT id,property_id,pos_order_id,transaction_id,cash_received,change_due,payment_reference,verified_by,verified_at FROM public.pos_settlements LIMIT 0',
    'SELECT property_id,qris_enabled,qris_merchant_id,qris_image_path,transfer_enabled,bank_account_number,debit_enabled,debit_edc_terminal FROM public.property_payment_instructions LIMIT 0',
    'SELECT id,property_id,amount,discount_amount,net_amount,source_type,source_id,reversal_of_transaction_id FROM public.transactions LIMIT 0',
    'SELECT id,property_id,transaction_id,scope FROM public.payment_transactions LIMIT 0',
    'SELECT property_id FROM public.folio_entries LIMIT 0',
    'SELECT property_id FROM public.transaction_daily_sequences LIMIT 0',
    'SELECT audit_id,property_id,new_value FROM public.audit_logs LIMIT 0'
  ]) await c.query(sql);
}
async function fixture(c, label, amount = 25000, lines = null, orderDiscount = 0) {
  const r = await c.query(`INSERT INTO properties(name,property_code,timezone,currency_code,is_active)
    VALUES($1,$2,'Asia/Jakarta','IDR',TRUE) RETURNING id`,
    ['POS multi ' + label + ' ' + run, crypto.randomBytes(3).toString('hex').toUpperCase()]);
  const f = {p:Number(r.rows[0].id), o:null, tx:[], st:[], pt:[], preserve:false};
  fixtures.push(f); // Track immediately, including partially constructed fixtures.
  const o = await c.query(`INSERT INTO pos_orders(property_id,order_number,status,total_amount,
    discount_type,discount_value,discount_amount) VALUES($1,$2,'OPEN',$3,$4,$5,$6) RETURNING id`,
    [f.p,'MM-' + run + '-' + fixtures.length,amount,orderDiscount ? 'PERCENT' : null,orderDiscount ? 10 : null,orderDiscount]);
  f.o = Number(o.rows[0].id);
  if (lines) {
    const cat = (await c.query('INSERT INTO pos_menu_categories(property_id,name) VALUES($1,$2) RETURNING id',[f.p,'Fixture ' + run])).rows[0].id;
    for (const line of lines) {
      const itemName = 'Fixture item ' + line.price;
      const menu = (await c.query('INSERT INTO pos_menu_items(property_id,category_id,name,price) VALUES($1,$2,$3,$4) RETURNING id',
        [f.p,cat,itemName,line.price])).rows[0].id;
      await c.query(`INSERT INTO pos_order_items(order_id,menu_item_id,item_name_snapshot,quantity,unit_price,discount_type,discount_value,discount_amount)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[f.o,menu,itemName,line.qty,line.price,line.type || null,line.value ?? null,line.discount || 0]);
    }
  }
  return f;
}
function input(f, method, key, methodInput) {
  return {propertyId:f.p,orderId:f.o,idempotencyKey:key,paymentMethod:method,
    methodInput,actorName:'mm-auth-actor',actorUserId:'42',correlationId:run};
}
async function state(c,f) {
  const data = {};
  for (const [table,id] of [['pos_orders','id'],['pos_settlements','id'],['transactions','id'],
    ['payment_transactions','id'],['folio_entries',null],['audit_logs','audit_id'],['transaction_daily_sequences',null]]) {
    const r = await c.query(`SELECT * FROM ${table} WHERE property_id=$1`,[f.p]);
    data[table] = r.rows.sort((a,b)=>id ? String(a[id]).localeCompare(String(b[id])) : JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return JSON.stringify(data);
}
async function rejected(c,f,args,code,status,label) {
  const before = await state(c,f);
  let e;
  try { await payPosOrder(c,args); } catch (err) { e = err; }
  check(label + ' error ' + code, e && e.code === code && e.statusCode === status);
  check(label + ' seluruh state/audit tetap', before === await state(c,f));
}
async function config(c,f,method,complete) {
  const qrKey=method==='QRIS'&&complete?await savePropertyQrisImage(f.p,{buffer:qrisPng,mimetype:'image/png'}):null;
  await c.query(`INSERT INTO property_payment_instructions(property_id,qris_enabled,qris_merchant_id,qris_image_path,
    transfer_enabled,bank_account_number,debit_enabled,debit_edc_terminal)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(property_id) DO UPDATE SET
    qris_enabled=EXCLUDED.qris_enabled,qris_merchant_id=EXCLUDED.qris_merchant_id,qris_image_path=EXCLUDED.qris_image_path,
    transfer_enabled=EXCLUDED.transfer_enabled,bank_account_number=EXCLUDED.bank_account_number,
    debit_enabled=EXCLUDED.debit_enabled,debit_edc_terminal=EXCLUDED.debit_edc_terminal`,
    [f.p,method==='QRIS',method==='QRIS'?'TEST-MERCHANT':null,qrKey,
      method==='TRANSFER',method==='TRANSFER'&&complete?'TEST-ACCOUNT':null,
      method==='DEBIT',method==='DEBIT'&&complete?'TEST-EDC':null]);
}
async function paid(c,f,args,expected,label,wrapper=false) {
  const result = wrapper ? await payPosOrderCash(c,args) : await payPosOrder(c,args);
  f.st.push(String(result.settlement.id)); f.tx.push(String(result.sale.id));
  check(label + ' created', result.created === true && result.replayed === false);
  const ss = (await c.query('SELECT * FROM pos_settlements WHERE property_id=$1',[f.p])).rows;
  const ts = (await c.query('SELECT * FROM transactions WHERE property_id=$1',[f.p])).rows;
  check(label + ' tepat satu settlement dan SALE', ss.length===1 && ts.length===1);
  const s=ss[0], t=ts[0];
  if (!s || !t) throw new Error(label + ' settlement/SALE hilang');
  check(label + ' linkage/property/source/status', String(s.transaction_id)===String(t.id) &&
    Number(s.pos_order_id)===f.o && Number(t.property_id)===f.p && t.source_type==='POS_ORDER' &&
    String(t.source_id)===String(f.o) && t.transaction_type==='SALE' && t.reversal_of_transaction_id===null &&
    s.status==='SUCCESS' && t.payment_status==='PAID' && s.payment_method===args.paymentMethod && t.payment_method===args.paymentMethod);
  check(label + ' gross/discount/net/settlement', Number(t.amount)===expected.gross &&
    Number(t.discount_amount)===expected.discount && Number(t.net_amount)===expected.net && Number(s.amount)===expected.net);
  check(label + ' order PAID', (await c.query('SELECT status FROM pos_orders WHERE id=$1 AND property_id=$2',[f.o,f.p])).rows[0].status==='PAID');
  if (args.paymentMethod==='CASH') {
    const cash=args.methodInput && args.methodInput.cashReceived;
    check(label + ' uang diterima/kembalian', cash == null ? s.cash_received===null && s.change_due===null :
      Number(s.cash_received)===cash && Number(s.change_due)===cash-expected.net);
    check(label + ' metadata CASH', s.payment_reference===null && s.verified_by===null && s.verified_at===null);
  } else {
    check(label + ' metadata non-CASH', s.cash_received===null && s.change_due===null &&
      s.payment_reference===(args.methodInput.paymentReference || '').trim() && s.verified_by==='mm-auth-actor' && s.verified_at!==null);
    check(label + ' verified_at response dari DB', result.settlement.verified_at===new Date(s.verified_at).toISOString());
  }
  const audits=(await c.query('SELECT * FROM audit_logs WHERE property_id=$1',[f.p])).rows;
  check(label + ' satu audit settlement', audits.length===1 && audits[0].action==='SETTLEMENT_'+args.paymentMethod &&
    String(audits[0].record_id)===String(s.id) && String(audits[0].actor_user_id)==='42');
  if (audits.length===1) {
    const a=JSON.parse(audits[0].new_value);
    check(label + ' audit amount/method/linkage', Number(a.amount)===expected.net && a.payment_method===args.paymentMethod &&
      String(a.transaction_id)===String(t.id) && Number(a.pos_order_id)===f.o &&
      a.verified_by===(args.paymentMethod==='CASH'?null:'mm-auth-actor'));
  }
  return result;
}
async function replay(c,f,args,original,label,wrapper=false) {
  const before=await state(c,f);
  const result=wrapper ? await payPosOrderCash(c,args) : await payPosOrder(c,{...args,actorName:'retry-actor',actorUserId:'43'});
  check(label + ' replay/sale ID sama', result.created===false && result.replayed===true && String(result.sale.id)===String(original.sale.id));
  check(label + ' settlement persis sama', JSON.stringify(result.settlement)===JSON.stringify(original.settlement));
  check(label + ' tanpa penulisan ulang', before===await state(c,f));
}
async function scenario(label,body) {
  console.log('\n── ' + label + ' ──');
  try { await body(); } catch(e) { problem(label,e); }
}
async function runCases(c) {
  const basic={gross:25000,discount:0,net:25000};
  await scenario('S1 CASH/replay/conflict/underpayment',async()=>{
    const f=await fixture(c,'cash');
    await rejected(c,f,input(f,'CASH',run+'-under',{cashReceived:24000}),'CASH_RECEIVED_INSUFFICIENT',422,'CASH kurang');
    const args=input(f,'CASH',run+'-cash',{cashReceived:50000});
    const result=await paid(c,f,args,basic,'CASH');
    await replay(c,f,args,result,'CASH retry');
    await rejected(c,f,{...args,methodInput:{cashReceived:50001}},'IDEMPOTENCY_CONFLICT',409,'CASH nominal berubah');
    await rejected(c,f,{...args,paymentMethod:'QRIS',methodInput:{}},'IDEMPOTENCY_CONFLICT',409,'Metode berubah');
    await rejected(c,f,{...args,idempotencyKey:run+'-new',paymentMethod:'QRIS',methodInput:{}},'ALREADY_PAID',409,'Key baru sebelum config guard');
  });
  for (const method of ['QRIS','TRANSFER','DEBIT']) await scenario(method+' config/payment/replay/conflict',async()=>{
    const f=await fixture(c,method,25000,[{qty:1,price:25000}]);
    const args=input(f,method,run+'-'+method,{paymentReference:'  REF-'+method+'  '});
    await rejected(c,f,args,method+'_NOT_CONFIGURED',422,method+' tanpa config');
    await config(c,f,method,false);
    await rejected(c,f,args,method+'_NOT_CONFIGURED',422,method==='QRIS'?'QRIS merchant ID tanpa gambar':method+' config tidak lengkap');
    if (method==='QRIS') {
      await c.query("UPDATE property_payment_instructions SET qris_image_path='   ' WHERE property_id=$1",[f.p]);
      await rejected(c,f,args,'QRIS_NOT_CONFIGURED',422,'QRIS gambar kosong/spasi');
      await c.query('UPDATE property_payment_instructions SET qris_image_path=$2 WHERE property_id=$1',
        [f.p,`branding/${f.p}/payment-qris/${crypto.randomUUID()}.png`]);
      await rejected(c,f,args,'QRIS_NOT_CONFIGURED',422,'QRIS file hilang');
      await c.query('UPDATE property_payment_instructions SET qris_image_path=$2 WHERE property_id=$1',
        [f.p,`branding/${f.p+1}/payment-qris/${crypto.randomUUID()}.png`]);
      await rejected(c,f,args,'QRIS_NOT_CONFIGURED',422,'QRIS key properti lain');
    }
    await config(c,f,method,true);
    const result=await paid(c,f,args,basic,method);
    await c.query('UPDATE property_payment_instructions SET qris_enabled=FALSE,transfer_enabled=FALSE,debit_enabled=FALSE WHERE property_id=$1',[f.p]);
    await replay(c,f,{...args,methodInput:{paymentReference:'REF-'+method}},result,method+' retry saat config disabled');
    await rejected(c,f,{...args,methodInput:{paymentReference:'OTHER'}},'IDEMPOTENCY_CONFLICT',409,method+' ref berubah');
    await rejected(c,f,{...args,idempotencyKey:run+'-other-'+method},'ALREADY_PAID',409,method+' key baru saat config disabled');
  });
  await scenario('S5 CASH wrapper/fingerprint legacy',async()=>{
    const f=await fixture(c,'wrapper');
    const args=input(f,'CASH',run+'-legacy');
    const result=await paid(c,f,args,basic,'Legacy CASH',true);
    check('Fingerprint CASH lama dipertahankan',result.settlement.request_fingerprint===computeCashSettlementFingerprint(f.p,f.o,'CASH'));
    await replay(c,f,args,result,'Wrapper retry',true);
    await replay(c,f,args,result,'Generalized retry legacy');
    await rejected(c,f,{...args,methodInput:{cashReceived:25000}},'IDEMPOTENCY_CONFLICT',409,'Legacy key dengan nominal baru');
  });
  const lines=[{qty:2,price:19500,type:'NOMINAL',value:5000,discount:5000},
    {qty:1,price:30000,type:'PERCENT',value:10,discount:3000}];
  await scenario('S6 gross/item/order discount',async()=>{
    const f=await fixture(c,'discount',54900,lines,6100);
    const args=input(f,'CASH',run+'-discount',{cashReceived:100000});
    const result=await paid(c,f,args,{gross:69000,discount:14100,net:54900},'Diskon per LINE lalu order');
    await replay(c,f,args,result,'Diskon replay');
  });
  await scenario('S7 snapshot mismatch rollback',async()=>{
    const f=await fixture(c,'mismatch',55000,lines,6100);
    await rejected(c,f,input(f,'CASH',run+'-mismatch',{cashReceived:100000}),'POS_SNAPSHOT_MISMATCH',422,'Snapshot tidak konsisten');
  });
  await scenario('S8 existing legacy payment',async()=>{
    const f=await fixture(c,'existing');
    await c.query("UPDATE pos_orders SET status='PAID' WHERE id=$1",[f.o]);
    const sale=await projectPosOrderToTransaction(c,f.o,{propertyId:f.p,paymentMethod:'CASH',actorName:'legacy-fixture'});
    if (!sale) throw new Error('SALE fixture legacy gagal');
    f.tx.push(String(sale.id));
    const p=await c.query(`INSERT INTO payment_transactions(property_id,transaction_id,transaction_type,amount,payment_method,status,scope)
      VALUES($1,$2,'PAYMENT',25000,'CASH','SUCCESS','ROOM_RESERVATION') RETURNING id`,[f.p,String(sale.id)]);
    f.pt.push(String(p.rows[0].id));
    // Legacy payment guard must precede status rejection, and must not create another SALE.
    await rejected(c,f,input(f,'CASH',run+'-existing',{cashReceived:50000}),'POS_EXISTING_PAYMENT_NOT_SUPPORTED',409,'Pembayaran legacy ditolak');
  });
  await scenario('S9 cross-property scope',async()=>{
    const f=await fixture(c,'scope'), other=await fixture(c,'other');
    const before=await state(c,other);
    await rejected(c,f,{...input(f,'CASH',run+'-scope'),propertyId:other.p},'CROSS_PROPERTY_ORDER',403,'Cross property');
    check('Property kedua tanpa perubahan',before===await state(c,other));
  });
  await scenario('S10 zero total remains unresolved/rejected',async()=>{
    const f=await fixture(c,'zero',0);
    await rejected(c,f,input(f,'CASH',run+'-zero',{cashReceived:0}),'INVALID_ORDER_AMOUNT',422,'Zero total');
  });
}
async function financialGuard(c,f) {
  for (const [table,expected] of [['transactions',f.tx],['pos_settlements',f.st],['payment_transactions',f.pt],['folio_entries',[]]]) {
    const ids=(await c.query(`SELECT id::text AS id FROM ${table} WHERE property_id=$1`,[f.p])).rows.map(r=>r.id);
    const extra=ids.filter(id=>!expected.includes(id));
    check('Financial guard property '+f.p+' '+table, extra.length===0 && expected.every(id=>ids.includes(id)));
    if (extra.length) { f.preserve=true; console.error('[PRESERVE] property '+f.p+' '+table+' unexpected IDs: '+extra.join(',')); }
  }
}
async function cleanup(c,f) {
  if (f.preserve) { console.error('[CLEANUP] property '+f.p+' dipertahankan untuk inspeksi.'); return; }
  await c.query('BEGIN');
  try {
    await c.query('DELETE FROM audit_logs WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM pos_settlements WHERE property_id=$1 AND id::text=ANY($2::text[])',[f.p,f.st]);
    await c.query('DELETE FROM payment_transactions WHERE property_id=$1 AND id::text=ANY($2::text[])',[f.p,f.pt]);
    await c.query('DELETE FROM transactions WHERE property_id=$1 AND id::text=ANY($2::text[])',[f.p,f.tx]);
    await c.query('DELETE FROM transaction_daily_sequences WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id=$1)',[f.p]);
    await c.query('DELETE FROM pos_orders WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM pos_menu_items WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM pos_menu_categories WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM property_payment_instructions WHERE property_id=$1',[f.p]);
    await c.query('DELETE FROM properties WHERE id=$1',[f.p]);
    await c.query('COMMIT');
    for(const k of qrisImages.keys())if(isPropertyQrisImageKey(k,f.p))await deletePropertyQrisImage(k,f.p);
  } catch(e) {
    try { await c.query('ROLLBACK'); } catch(rb) { e.discardClient=true; problem('cleanup rollback',rb); }
    throw e;
  }
}
async function residue(c) {
  const ids=fixtures.map(f=>f.p);
  if (!ids.length) return;
  for (const table of ['pos_orders','pos_settlements','transactions','payment_transactions','folio_entries',
    'audit_logs','transaction_daily_sequences','pos_menu_items','pos_menu_categories','property_payment_instructions']) {
    const n=Number((await c.query(`SELECT COUNT(*) AS n FROM ${table} WHERE property_id=ANY($1::int[])`,[ids])).rows[0].n);
    check('Residue '+table+' = 0',n===0);
  }
  const itemIds=fixtures.map(f=>f.o).filter(Boolean);
  check('Residue pos_order_items = 0',Number((await c.query('SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id=ANY($1::int[])',[itemIds])).rows[0].n)===0);
  check('Residue properties = 0',Number((await c.query('SELECT COUNT(*) AS n FROM properties WHERE id=ANY($1::int[])',[ids])).rows[0].n)===0);
}
function release(c,label,discard=false) { if(c) try { c.release(discard); } catch(e) {problem(label+' release',e);} }
async function main() {
  let c=null, verified=false;
  console.log('[POS MULTI-METHOD TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');
  try {
    c=await pool.connect(); await identity(c); await schema(c); verified=true;
    console.log('[IDENTITY/SCHEMA] terverifikasi.');
    for(const fn of [payPosOrder,payPosOrderCash,computeCashSettlementFingerprint,projectPosOrderToTransaction])
      if(typeof fn!=='function') throw new Error('dist export tidak lengkap; build diperlukan');
    await runCases(c);
  } catch(e) { problem('main',e); }
  finally {
    // Release the service client. Cleanup always gets a fresh, independently verified client.
    // No service transaction is carried into cleanup; discard the main client after use.
    release(c,'main',true); c=null;
    if(verified) for(const f of fixtures) {
      let cc=null, bad=false;
      try {
        cc=await pool.connect(); await identity(cc);
        await financialGuard(cc,f); await cleanup(cc,f);
      } catch(e) { bad=Boolean(e.discardClient); f.preserve=true; problem('cleanup property '+f.p,e); }
      finally {release(cc,'cleanup',bad);}
    }
    if(verified) {
      let rc=null;
      try { rc=await pool.connect(); await identity(rc); await residue(rc); }
      catch(e) {problem('residue',e);}
      finally {release(rc,'residue');}
    }
    check('Residue QRIS image fixture = 0',qrisImages.size===0);
    setBrandingStorageAdapterForTesting(null);
    try {await pool.end();} catch(e) {problem('pool.end',e);}
  }
  console.log('\n[RESULT] '+passed+' PASS, '+failures.length+' FAIL');
  if(failures.length) for(const f of failures) console.error('  - '+f);
  else console.log('[CLEANUP/RESIDUE] 0 — seluruh fixture bersih.');
  process.exitCode=failures.length?1:0;
}
main().catch(e=>{console.error('[CRASH]',e.message);process.exitCode=1;});
