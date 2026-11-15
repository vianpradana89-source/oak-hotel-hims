// C: execute actual route, preflight, claim, DP adapter, finalize/COMMIT/catch/finally.
// Guest/room/calendar/ordinary SQL writer middle is injected work, not reimplemented.
// Actual A/B/HTTP/payment helpers are used. No index import, Pool, server, DB or HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const endpoint = require('../dist/domains/reservations/bookingCreateEndpointService');
const http = require('../dist/domains/reservations/bookingCreateHttpService');
const requestSvc = require('../dist/domains/reservations/bookingCreateRequestService');
const payment = require('../dist/domains/reservations/bookingCreatePaymentService');
const intent = require('../dist/domains/reservations/bookingPaymentIntentService');
const source = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
assert.equal(ast.parseDiagnostics.length, 0);
function fn(name) {
  const n = ast.statements.find(x => ts.isFunctionDeclaration(x) && x.name?.text === name && x.body);
  assert.ok(n, 'actual function with body: ' + name); return n;
}
function appCall(method, predicate) {
  const found = ast.statements.map(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) ? s.expression : null)
    .find(c => c && ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText(ast) === 'app' &&
      c.expression.name.text === method && predicate(c));
  assert.ok(found, 'actual app.' + method); return found;
}
const canonical = fn('createCanonicalBooking'), body = [...canonical.body.statements];
const outer = body.find(n => ts.isTryStatement(n) && n.finallyBlock);
assert.ok(outer?.catchClause);
const tx = [...outer.tryBlock.statements];
function declares(n, name) {
  return ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name);
}
const clientIndex = body.findIndex(n => declares(n, 'client'));
const propertyIndex = tx.findIndex(n => declares(n, 'propertyResult'));
const dpIndex = tx.findIndex(n => declares(n, 'dpReceiptResult'));
const groupIndex = tx.findIndex(n => declares(n, 'groupPaymentResult'));
const finalIndex = tx.findIndex(n => declares(n, 'explicitCtx'));
assert.ok(clientIndex >= 0 && propertyIndex > 0 && dpIndex > 0 && groupIndex > dpIndex && finalIndex > groupIndex);
const finalStartIndex = finalIndex > 0 && /^commitAttempted\s*=\s*true;?$/.test(tx[finalIndex-1].getText(ast).trim()) ? finalIndex-1 : finalIndex;
const routeCall = appCall('post', c => c.arguments[0]?.text === '/api/bookings');
const route = routeCall.arguments.at(-1);
const helperNames = ['normalizeBookingSourceValue','deriveBookingCollectionContext',
  'normalizeGuestSegmentValue','normalizeCurrencyCodeValue','createHttpError',
  'buildScopedBookingPayloadFingerprint','bookingScopedLegacyCacheLookup',
  'bookingScopedLegacyCacheClaim','bookingScopedLegacyCachePersist'];
const sources = helperNames.map(n => fn(n).getText(ast)).join('\n');
const sourceConst = ast.statements.find(n => declares(n, 'VALID_EXTENDED_BOOKING_SOURCES'));
assert.ok(sourceConst);
// Transaction middle is deliberately one dependency boundary. Everything around it
// (including actual DP call and finalization branch) comes from production source.
const harness = `async function runCanonical(req, bookingPayload, reservationPayloads, options={}) {
  ${body.slice(0, clientIndex).map(n => n.getText(ast)).join('\n')}
  ${body.slice(clientIndex, body.indexOf(outer)).map(n => n.getText(ast)).join('\n')}
  try {
    ${tx.slice(0, propertyIndex).map(n => n.getText(ast)).join('\n')}
    const facts = await deps.work(client, savedEvidenceKeys, explicitOrdinaryPaymentPlan, paymentIntent);
    const bookingRecord = facts.bookingRecord, insertedChildren = facts.insertedChildren;
    const bookingLegacyNumber = facts.bookingLegacyNumber, groupPaymentResult = facts.groupPaymentResult;
    ${tx.slice(dpIndex, groupIndex).map(n => n.getText(ast)).join('\n')}
    ${tx.slice(finalStartIndex).map(n => n.getText(ast)).join('\n')}
  } ${outer.catchClause.getText(ast)} finally ${outer.finallyBlock.getText(ast)}
}`;
const executable = ts.transpileModule(sourceConst.getText(ast) + '\n' + sources + '\n' + harness +
  '\nconst createCanonicalBooking=runCanonical; const api={canonical:runCanonical,route:' + route.getText(ast) +
  ',derive:deriveBookingCollectionContext};', { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS }}).outputText;
const copy = v => JSON.parse(JSON.stringify(v));
const tuple = (p, k) => JSON.stringify([p,k]);
const goodFile = (content='proof') => ({ buffer: Buffer.from(content), mimetype:'image/png', originalname:'proof.png', size:Buffer.byteLength(content) });
function payload(mode='UNPAID') {
  return { property_id:1, payment_mode:mode, guest_name:'Guest', guest_phone:'00123',
    reservations:[{ room_id:1, guest_name:'Guest' }],
    ...(mode==='PAY_BILL' ? { amount_paid:30,payment_method:'CASH' } : {}),
    ...(mode==='ADVANCE_PAYMENT' ? { advance_amount:50,payment_method:'CASH' } : {}) };
}
function req(p=payload(), key='key-C', file=null) {
  return { method:'POST',path:'/api/bookings',body:p,headers:{'idempotency-key':key},file,
    user:{id:7,full_name:'UAT',role:'FO',property_id:1} };
}
function res() {
  return { statusCode:200,body:null,headersSent:false,
    status(n){this.statusCode=n;return this;},json(v){this.body=copy(v);return this;},setHeader(){} };
}
function contextFor(p, key='key-C', file=null) {
  return endpoint.prepareExplicitBookingCreateContext({payload:p,propertyId:Number(p.property_id),
    headerKey:key,bodyKey:p.request_key,upload:file,channelType:p.booking_channel==='OTA'?'OTA':'WALK_IN',
    paymentResponsibility:p.payment_responsibility||'HOTEL_COLLECT'});
}
function finalRow(ctx) {
  const response = http.buildBookingCreateHttpResponse({booking:{id:101,bid:'B-old',property_id:ctx.propertyId,
    booking_status:'ACTIVE',guest_name_snapshot:'Guest',guest_phone_snapshot:'00123',booking_source:'WALKIN',channel:null,currency_code:'IDR'},
    reservations:[{id:201,booking_id:101}],correlationId:'CORR-stored',dp_metadata:{deposit_id:88}});
  return {property_id:ctx.propertyId,request_key:ctx.requestKey,status:'FINAL',fingerprint:ctx.fingerprint,
    fingerprint_version:ctx.fingerprintVersion,booking_id:101,result:response.responseBody,response_status:201,finalized_at:'2026-11-11T00:00:00Z'};
}
function setup(options={}) {
  const env={rows:new Map(),events:[],releases:[],queries:[],logs:[],work:0,receipts:0,rules:0,ordinary:0,broadcasts:0,cleanup:[],clients:[]};
  function makeClient(kind) {
    let snapshot=null,active=false;
    const c={kind,async query(sql,args=[]) {
      env.events.push(kind+':'+sql.split(/\s+/)[0]);env.queries.push({client:c,sql,args:[...args]});
      if(sql==='BEGIN'){active=true;snapshot=new Map([...env.rows].map(([k,v])=>[k,copy(v)]));return {rows:[],rowCount:0};}
      if(sql==='ROLLBACK'){
        if(options.rollbackError) throw options.rollbackError;
        if(snapshot)env.rows=new Map(snapshot);active=false;return {rows:[],rowCount:0};
      }
      if(sql==='COMMIT'){
        active=false;
        if(options.commitError)throw options.commitError;
        return {rows:[],rowCount:0};
      }
      assert.match(sql,/booking_create_requests|idempotency_keys/);
      if(/idempotency_keys/.test(sql)){
        env.events.push('global-cache');
        if(/^SELECT/.test(sql))return {rows:[],rowCount:0};
        return {rows:[{key:args[0]}],rowCount:1};
      }
      const k=tuple(args[0],args[1]);
      if(/^SELECT/.test(sql)){
        if(options.readError && kind==='read')throw options.readError;
        if(kind==='tx' && options.raceRow && !env.raceSeeded){
          env.raceSeeded=true;env.rows.set(k,copy(options.raceRow));snapshot.set(k,copy(options.raceRow));
        }
        const row=env.rows.get(k);return {rows:row?[copy(row)]:[],rowCount:row?1:0};
      }
      if(/^INSERT/.test(sql)){
        if(options.claimError)throw options.claimError;
        if(env.rows.has(k))return {rows:[],rowCount:0};
        const row={property_id:args[0],request_key:args[1],status:'PENDING',fingerprint:args[2],fingerprint_version:args[3],payment_intent:JSON.parse(args[4]),booking_id:null,result:null,response_status:201,finalized_at:null};
        env.rows.set(k,row);return {rows:[copy(row)],rowCount:1};
      }
      if(/^UPDATE/.test(sql)){
        if(options.finalizeError)throw options.finalizeError;
        const row=env.rows.get(k);
        if(!row || row.status!=='PENDING'||row.fingerprint!==args[5]||row.fingerprint_version!==args[6])return {rows:[],rowCount:0};
        Object.assign(row,{status:'FINAL',booking_id:args[2],result:JSON.parse(args[3]),response_status:args[4],finalized_at:'2026-11-11T00:00:00Z'});
        return {rows:[],rowCount:1};
      }
      throw Error('unexpected mock query');
    },release(discard){
      if(!discard)assert.equal(active,false,'must not release open transaction');
      env.releases.push({kind,discard:!!discard});active=false;
    }};
    env.clients.push(c);return c;
  }
  let connects=0;
  const pool={async connect(){const kind=connects++===0 && !options.direct?'read':'tx';env.events.push('connect:'+kind);return makeClient(kind);},
    query:async (...args)=>makeClient('legacy').query(...args)};
  const deps={work:async(c,keys,plan,paymentIntent)=>{
    env.events.push('work');env.work++;
    if(plan?.bookingLevelCash>0)env.ordinary++;
    if(options.workEvidence){keys.push('work-proof');}
    if(options.workError)throw options.workError;
    return {bookingRecord:{id:101,property_id:1,bid:'B-fresh'},insertedChildren:options.children||[{id:201,booking_id:101,stay_sequence:1,check_in:new Date('2026-11-11T00:00:00Z'),...(options.badSnapshot?{bad:Buffer.from('invalid')}: {})}],bookingLegacyNumber:'L-1',groupPaymentResult:null};
  }};
  const values={pool,deps,crypto,Buffer,process:{env:{}},console:{error:(...x)=>env.logs.push(x),warn(){},log(){}},
    require:n=>{assert.equal(n,'fs');return {writeFileSync(){}};},
    normalizeBookingPaymentIntent:intent.normalizeBookingPaymentIntent,
    computeBookingCreateFingerprint:requestSvc.computeBookingCreateFingerprint,
    BOOKING_CREATE_ENDPOINT_FP_VERSION:endpoint.BOOKING_CREATE_ENDPOINT_FP_VERSION,
    prepareExplicitBookingCreateContext:endpoint.prepareExplicitBookingCreateContext,
    readBookingCreateEndpointReplay:endpoint.readBookingCreateEndpointReplay,
    claimBookingCreateEndpoint:endpoint.claimBookingCreateEndpoint,
    finalizeBookingCreateEndpoint:endpoint.finalizeBookingCreateEndpoint,
    getQuickBookingRules:async()=>{env.rules++;env.events.push('rules');if(options.rulesError)throw options.rulesError;return {rules:{WALK_IN:{},OTA:{}}};},
    hasRows:r=>Number(r?.rowCount??0)>0,
    ...Object.fromEntries(['evaluateBookingPaymentGates','buildOrdinaryPaymentPlan','resolveBookingRequestKey','convertFileToEvidence',
      'validateDpReceiptMethod','buildDpReceiptPlan','callDpReceiptInBookingTransaction','buildDpResultMetadata'].map(n=>[n,payment[n]])),
    validateEvidenceUpload:()=>({valid:true}),withReservationHotelDates:row=>row,
    receiveDepositInTransaction:async(c,_input,owner)=>{
      assert.equal(c.kind,'tx');env.events.push('receive');env.receipts++;env.receiptClient=c;
      if(options.receiptEvidence)owner.registerStorageKey('receipt-proof');
      if(options.receiptError)throw options.receiptError;
      return {id:88,deposit_number:'DP-88',payment:{id:99}};
    },
    deleteEvidenceFile:async k=>{env.events.push('cleanup');env.cleanup.push(k);},
    assertPropertyScope:async()=>{env.events.push('scope');if(options.forbidden)throw Object.assign(Error('Forbidden'),{statusCode:403});},
    responseStatusTextForCode:n=>n>=500?'ERROR':'FAILED',isRoomOverlapViolation:()=>false,
    sendRoomOverlapConflict:r=>r.status(409).json({status:'FAILED'}),
    buildLegacyBookingCacheKey:http.buildLegacyBookingCacheKey,
    buildEvidenceDescriptor:require('../dist/domains/reservations/bookingCreateContextService').buildEvidenceDescriptor,
    broadcastEvent:()=>{env.events.push('broadcast');env.broadcasts++;if(options.broadcastError)throw options.broadcastError;}
  };
  const api=new Function(...Object.keys(values),executable+'\nreturn api;')(...Object.values(values));
  return {api,env};
}
async function call(h,p=payload(),file=null){const r=res();await h.api.route(req(p,'key-C',file),r);return r;}
const isError=(status,code)=>e=>e.statusCode===status&&(!code||e.code===code);
let passed=0,failed=0;
async function test(name,run){try{await run();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.stack||e));}}
(async()=>{
  await test('early FINAL bypasses rules/writers and preserves stored response',async()=>{
    const h=setup(),p=payload(),ctx=contextFor(p),row=finalRow(ctx);h.env.rows.set(tuple(1,ctx.requestKey),row);
    const r=await call(h,p);assert.equal(r.statusCode,201);assert.deepEqual(r.body,row.result);
    assert.equal(h.env.work,0);assert.equal(h.env.rules,0);assert.equal(h.env.broadcasts,0);
    assert.deepEqual(h.env.releases,[{kind:'read',discard:false}]);
  });
  for(const mode of ['PAY_BILL','ADVANCE_PAYMENT','UNPAID'])await test('fresh actual transaction/finalize '+mode,async()=>{
    const h=setup(),p=payload(mode),r=await call(h,p);
    assert.equal(r.statusCode,201,JSON.stringify(r.body));assert.equal(h.env.work,1);assert.equal(h.env.receipts,mode==='ADVANCE_PAYMENT'?1:0);
    assert.equal(h.env.ordinary,mode==='PAY_BILL'?1:0);
    const row=h.env.rows.get(tuple(1,'key-C'));assert.equal(row.status,'FINAL');assert.deepEqual(r.body,row.result);
    const q=h.env.queries,update=q.findIndex(x=>/^UPDATE booking_create_requests/.test(x.sql));
    const commit=q.findIndex(x=>x.sql==='COMMIT');assert.ok(update>=0&&update<commit);
    assert.equal(q[update].client,q[commit].client);assert.ok(h.env.events.indexOf('tx:INSERT')<h.env.events.indexOf('work'));
    assert.ok(h.env.events.indexOf('tx:COMMIT')<h.env.events.indexOf('broadcast'));
    assert.equal(h.env.events.includes('global-cache'),false);assert.equal(h.env.releases.length,2);
    if(mode==='ADVANCE_PAYMENT')assert.equal(r.body.data.dp_metadata.deposit_id,88);
  });

  for(const bad of [null,[],{booking_payload:'null'},{...payload(),property_id:true}])await test('bad input no domain/writer '+JSON.stringify(bad),async()=>{
    const h=setup(),r=await call(h,bad);assert.equal(r.statusCode,400);assert.equal(h.env.queries.length,0);assert.equal(h.env.work,0);
  });
  await test('forbidden property no lookup/work',async()=>{
    const h=setup({forbidden:true}),r=await call(h);assert.equal(r.statusCode,403);assert.equal(h.env.queries.length,0);assert.equal(h.env.work,0);
  });
  for(const responsibility of ['INVALID','OTA_COLLECT'])await test('invalid collection controlled400 '+responsibility,async()=>{
    const h=setup(),r=await call(h,{...payload(),payment_responsibility:responsibility});
    assert.equal(r.statusCode,400);assert.equal(h.env.queries.length,0);assert.equal(h.env.work,0);
  });
  await test('unknown explicit mode and conflicting aliases fail before read',async()=>{
    for(const p of [{...payload(),payment_mode:'UNKNOWN'},{...payload(),request_key:'other'}]){
      const h=setup(),r=await call(h,p);assert.equal(r.statusCode,400);assert.equal(h.env.queries.length,0);assert.equal(h.env.work,0);
    }
  });
  for(const change of [{status:'PENDING',booking_id:null,result:null,finalized_at:null},{fingerprint:'f'.repeat(64)},
    {fingerprint_version:999},{result:null}])await test('early invalid/incomplete row blocks work '+JSON.stringify(change),async()=>{
    const h=setup(),ctx=contextFor(payload());h.env.rows.set(tuple(1,'key-C'),{...finalRow(ctx),...change});
    const r=await call(h);assert.equal(r.statusCode,409);assert.equal(h.env.work,0);assert.equal(h.env.rules,0);assert.equal(h.env.releases.length,1);
  });
  await test('foreign stored public binding never sent',async()=>{
    const h=setup(),row=finalRow(contextFor(payload()));row.result.data.property_id=2;h.env.rows.set(tuple(1,'key-C'),row);
    const r=await call(h);assert.equal(r.statusCode,409);assert.equal(h.env.work,0);assert.ok(!JSON.stringify(r.body).includes('B-old'));
  });
  for(const phase of ['read','claim','finalize'])await test('schema readiness '+phase+' leaves no committed fresh row',async()=>{
    const error=Object.assign(Error('schema not ready'),{code:'42P01'}),h=setup({[phase+'Error']:error}),r=await call(h);
    assert.equal(r.statusCode,503);assert.equal(r.body.code,'BOOKING_CREATE_REPLAY_NOT_READY');assert.equal(h.env.rows.size,0);
    if(phase!=='finalize')assert.equal(h.env.work,0);
    assert.equal(h.env.events.includes('global-cache'),false);
  });
  await test('unrelated early read failure is error, never absent; released',async()=>{
    const h=setup({readError:Error('read connection failed')}),r=await call(h);
    assert.equal(r.statusCode,500);assert.equal(h.env.work,0);assert.deepEqual(h.env.releases,[{kind:'read',discard:false}]);
  });
  await test('early miss / claim winner FINAL closes read-only tx before replay',async()=>{
    const row=finalRow(contextFor(payload())),h=setup({raceRow:row}),r=await call(h);
    assert.equal(r.statusCode,201);assert.deepEqual(r.body,row.result);assert.equal(h.env.work,0);assert.equal(h.env.receipts,0);assert.equal(h.env.broadcasts,0);
    assert.ok(h.env.events.includes('tx:ROLLBACK'));assert.equal(h.env.events.includes('tx:COMMIT'),false);
    assert.deepEqual(h.env.releases,[{kind:'read',discard:false},{kind:'tx',discard:false}]);
  });
  await test('race replay close failure cannot send success and discards',async()=>{
    const h=setup({raceRow:finalRow(contextFor(payload())),rollbackError:Error('read-only close failed')}),r=await call(h);
    assert.equal(r.statusCode,500);assert.match(r.body.message,/read-only close failed/);assert.equal(h.env.work,0);assert.equal(h.env.broadcasts,0);
    assert.equal(h.env.releases.at(-1).discard,true);
  });
  await test('finalize failure actually rolls back before cleanup (not COMMIT-attempted)',async()=>{
    const h=setup({finalizeError:Error('finalize failed'),workEvidence:true,receiptEvidence:true}),r=await call(h,payload('ADVANCE_PAYMENT'),goodFile());
    assert.equal(r.statusCode,500);assert.equal(h.env.work,1);assert.equal(h.env.receipts,1);assert.equal(h.env.rows.size,0);
    assert.ok(h.env.events.includes('tx:ROLLBACK'));assert.equal(h.env.events.includes('tx:COMMIT'),false);
    assert.deepEqual(h.env.cleanup,['work-proof','receipt-proof']);assert.ok(h.env.events.indexOf('tx:ROLLBACK')<h.env.events.indexOf('cleanup'));
    assert.equal(h.env.releases.at(-1).discard,false);assert.equal(h.env.broadcasts,0);
  });
  await test('snapshot builder failure rolls back DP + claim and cleans owner',async()=>{
    const h=setup({badSnapshot:true,receiptEvidence:true}),r=await call(h,payload('ADVANCE_PAYMENT'),goodFile());
    assert.equal(r.statusCode,500);assert.equal(h.env.rows.size,0);assert.ok(h.env.events.includes('tx:ROLLBACK'));
    assert.deepEqual(h.env.cleanup,['receipt-proof']);assert.ok(!h.env.queries.some(q=>/^UPDATE booking_create_requests/.test(q.sql)));
  });
  await test('rollback failure retains evidence/discards and preserves finalize error',async()=>{
    const h=setup({finalizeError:Error('original finalize failed'),rollbackError:Error('rollback failed'),receiptEvidence:true});
    const r=await call(h,payload('ADVANCE_PAYMENT'),goodFile());assert.equal(r.statusCode,500);assert.match(r.body.message,/original finalize failed/);
    assert.deepEqual(h.env.cleanup,[]);assert.equal(h.env.releases.at(-1).discard,true);assert.equal(h.env.broadcasts,0);
  });
  await test('COMMIT acknowledgement lost preserves FINAL/evidence; same-key retry replays',async()=>{
    const h=setup({commitError:Error('ack lost'),receiptEvidence:true}),p=payload('ADVANCE_PAYMENT'),f=goodFile();
    const first=await call(h,p,f);assert.equal(first.statusCode,500);assert.equal(h.env.rows.get(tuple(1,'key-C')).status,'FINAL');
    assert.deepEqual(h.env.cleanup,[]);assert.equal(h.env.releases.at(-1).discard,true);assert.equal(h.env.broadcasts,0);
    const retry=await call(h,p,f);assert.equal(retry.statusCode,201);assert.equal(h.env.work,1);assert.equal(h.env.receipts,1);
    assert.deepEqual(retry.body,h.env.rows.get(tuple(1,'key-C')).result);
  });
  await test('receipt throw after registering owner key rolls back and cleans key',async()=>{
    const h=setup({receiptEvidence:true,receiptError:Error('receipt failed')});const r=await call(h,payload('ADVANCE_PAYMENT'),goodFile());
    assert.equal(r.statusCode,500);assert.equal(h.env.rows.size,0);assert.deepEqual(h.env.cleanup,['receipt-proof']);assert.equal(h.env.broadcasts,0);
  });
  await test('multi-room DP one receipt, deterministic anchor and same transaction client',async()=>{
    const children=[{id:202,booking_id:101,stay_sequence:2},{id:201,booking_id:101,stay_sequence:1}];
    const h=setup({children}),p={...payload('ADVANCE_PAYMENT'),reservations:[{room_id:1},{room_id:2}]},r=await call(h,p);
    assert.equal(r.statusCode,201);assert.equal(h.env.receipts,1);assert.equal(h.env.ordinary,0);
    assert.equal(r.body.data.dp_metadata.deposit_scope,'BOOKING_GROUP');assert.equal(r.body.data.dp_metadata.deposit_reservation_id,201);
    assert.equal(h.env.queries.find(q=>/^UPDATE booking_create_requests/.test(q.sql)).client,h.env.receiptClient);
  });
  await test('OTA UNPAID voucher identity replayed; changed bytes mismatch',async()=>{
    const h=setup(),p={...payload(),booking_channel:'OTA',payment_responsibility:'OTA_COLLECT'},f=goodFile();
    const first=await call(h,p,f);assert.equal(first.statusCode,201);assert.equal(h.env.receipts,0);assert.equal(h.env.ordinary,0);
    assert.equal((await call(h,p,goodFile('other'))).statusCode,409);assert.equal(h.env.work,1);
    assert.deepEqual((await call(h,p,f)).body,first.body);
  });
  for(const mode of ['PAY_BILL','ADVANCE_PAYMENT'])await test('OTA positive hotel cash/DP fixed gate rejects '+mode,async()=>{
    const h=setup(),p={...payload(mode),booking_channel:'OTA',payment_responsibility:'OTA_COLLECT'};
    assert.equal((await call(h,p,goodFile())).statusCode,400);assert.equal(h.env.work,0);assert.equal(h.env.receipts,0);
  });
  await test('normalized key shared with DP receipt key and domain row',async()=>{
    const h=setup(),p={...payload('ADVANCE_PAYMENT'),request_key:'key-C'},q=req(p,' key-C '),r=res();await h.api.route(q,r);
    assert.equal(r.statusCode,201);assert.ok(h.env.rows.has(tuple(1,'key-C')));
    const expected=require('../dist/domains/reservations/bookingCreateContextService').deriveDpReceiptKey({propertyId:1,requestKey:'key-C',intent:intent.normalizeBookingPaymentIntent(p)});
    assert.equal(r.body.data.dp_metadata.deposit_idempotency_key,expected);
  });
  for(const field of ['propertyId','requestKey','childCount','intent','fingerprintVersion'])await test('canonical context binding rejects mismatch '+field,async()=>{
    const h=setup({direct:true}),p=payload(),ctx=contextFor(p);
    ctx[field]=field==='intent'?{...ctx.intent,mode:'PAY_BILL'}:field==='requestKey'?'other':999;
    await assert.rejects(h.api.canonical(req(p),p,p.reservations,{explicitContext:ctx}),isError(409,'BOOKING_CREATE_CONTEXT_MISMATCH'));
    assert.equal(h.env.work,0);assert.equal(h.env.queries.length,0);
  });
  await test('client supplied options/FP cannot replace server context',async()=>{
    const h=setup(),p={...payload(),explicitContext:{propertyId:99,fingerprint:'client'},fingerprint:'client',fingerprint_version:99};
    assert.equal((await call(h,p)).statusCode,201);const row=h.env.rows.get(tuple(1,'key-C'));
    assert.notEqual(row.fingerprint,'client');assert.equal(row.fingerprint_version,endpoint.BOOKING_CREATE_ENDPOINT_FP_VERSION);
  });
  await test('broadcast failure cannot overwrite FINAL',async()=>{
    const h=setup({broadcastError:Error('bus failed')}),r=await call(h);assert.equal(r.statusCode,201);assert.equal(h.env.rows.get(tuple(1,'key-C')).result.status,'SUCCESS');
    const n=h.env.work;assert.equal((await call(h)).statusCode,201);assert.equal(h.env.work,n);
  });
  await test('transport failure after headers does not overwrite FINAL or clean evidence',async()=>{
    const h=setup({receiptEvidence:true}),p=payload('ADVANCE_PAYMENT'),r=res();
    r.json=function(){this.headersSent=true;throw Error('socket closed');};await h.api.route(req(p,'key-C',goodFile()),r);
    assert.equal(h.env.rows.get(tuple(1,'key-C')).result.status,'SUCCESS');assert.deepEqual(h.env.cleanup,[]);
    assert.equal((await call(h,p,goodFile())).statusCode,201);assert.equal(h.env.work,1);
  });
  for(const multipart of [false,true])await test('legacy shape independent of domain schema multipart='+multipart,async()=>{
    const h=setup({direct:true,readError:Error('domain table absent')}),p=payload();delete p.payment_mode;
    const r=await call(h,multipart?{booking_payload:JSON.stringify(p)}:p);assert.equal(r.statusCode,201);assert.equal(r.body.status,'SUCCESS');
    assert.equal(r.body.data.dp_metadata,undefined);assert.equal(h.env.rows.size,0);assert.ok(!h.env.queries.some(q=>/booking_create_requests/.test(q.sql)));
  });
  await test('AST proves claim before writer region and DP call outside child loop',()=>{
    const claim=tx.findIndex(n=>n.getText(ast).includes('claimBookingCreateEndpoint('));assert.ok(claim>=0&&claim<propertyIndex);
    const dpIf=tx[dpIndex+2];assert.ok(ts.isIfStatement(dpIf));assert.match(dpIf.getText(ast),/callDpReceiptInBookingTransaction\(\s*client/);
    assert.ok(dpIndex<finalIndex);assert.match(tx[finalIndex+1].getText(ast),/finalizeBookingCreateEndpoint\(client/);
  });

  await test('shared collection derivation preserves OTA aliases/defaults and ota_source_id',()=>{
    const h=setup();
    for(const src of ['BOOKING_COM','AGODA','TRAVELOKA','TIKET_COM']){
      const d=h.api.derive(src,undefined,null,'OTA_COLLECT');assert.equal(d.channelType,'OTA');assert.equal(d.bookingChannel,'OTA');
    }
    assert.equal(h.api.derive('WALKIN',undefined,null,null).channelType,'WALK_IN');
    assert.equal(h.api.derive('WALKIN',undefined,3,'OTA_COLLECT').channelType,'OTA');
    assert.equal(h.api.derive('WALKIN','OTA',null,'OTA_COLLECT').channelType,'OTA');
  });
  console.log('RESULT PASS='+passed+' FAIL='+failed+' TOTAL='+(passed+failed));
  console.log('Production preflight/claim/DP/finalize/lifecycle extraction; other booking writers mocked. No PostgreSQL/HTTP claim.');
  process.exitCode=failed?1:0;
})();
