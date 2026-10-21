'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sourceArg = process.argv.indexOf('--source-dir');
const sourceDir = sourceArg >= 0 ? path.resolve(process.argv[sourceArg + 1]) : path.join(__dirname, '../src/features/pos');
const contractOnly = process.argv.includes('--contract-only');
let ts;
try { ts = require('typescript'); } catch (e) { if (!contractOnly) throw new Error('TypeScript dependency missing; run from frontend/test after npm install.'); }
function compile(file, pure = false) {
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  if (ts) return ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}, fileName: file}).outputText;
  assert.ok(pure);
  const code = require('node:module').stripTypeScriptTypes(text);
  const names = [...code.matchAll(/export (?:function|const) (\w+)/g)].map(m => m[1]);
  return code.replace(/export /g, '') + '\nmodule.exports = {' + names.join(',') + '};';
}
function load(code, imports = {}) {
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, require: name => {
    if (name in imports) return imports[name]; throw new Error('Unexpected import ' + name);
  }, console: {error() {}, warn() {}}, crypto: {randomUUID}, AbortController, URL, Response, Blob,
    window: {setTimeout() {return 1;}, clearTimeout() {}}, document: {activeElement: {focus() {}}}}, {timeout: 3000});
  return module.exports;
}
const D = load(compile('posOrderDraft.ts', true));
const P = load(compile('posPermissions.ts', true));
let pass = 0;
function check(name, action) {action(); pass++; console.log('  PASS  ' + name);}
const details = {propertyId: 7, reservationId: null, tableNumber: ' A1 ', guestName: ' Owner ',
  guestPhone: ' +628123456789 ', notes: ' Order note ', discountType: '', discountInput: '', discountReason: ''};
const lines = [{item: {id: 1, name: 'Coffee', price: '13000'}, qty: 3, discountType: 'NOMINAL', discountInput: '5000', notes: ' hot '},
  {item: {id: 2, name: 'Tea', price: 10000}, qty: 3, discountType: 'PERCENT', discountInput: '10'}];
const full = {...details, discountType: 'PERCENT', discountInput: '10', discountReason: ' Member '};
const plain = [{item: {id: 1, name: 'Coffee', price: 13000}, qty: 1}];
check('Per-LINE discount then order discount: 69000 - 8000 - 6100 = 54900', () => {
  const p = D.previewPosDraft(lines, 'PERCENT', '10');
  assert.equal(p.gross, 69000); assert.equal(p.itemDiscount, 8000); assert.equal(p.subtotal, 61000);
  assert.equal(p.orderDiscount, 6100); assert.equal(p.total, 54900);
  assert.equal(p.lines[0].discount, 5000); assert.equal(p.lines[1].discount, 3000);
});
check('Whole rupiah percentage rounds per LINE before order', () => {
  const p = D.previewPosDraft([{item: {id:1,name:'Item',price:101},qty:1,discountType:'PERCENT',discountInput:'50'}],'PERCENT','50');
  assert.equal(p.lines[0].discount,51); assert.equal(p.subtotal,50); assert.equal(p.orderDiscount,25); assert.equal(p.total,25);
});
check('Create payload carries snapshots/granular discounts, no client prices/totals/actor', () => {
  const b = D.buildPosOrderDraft(lines, full, true);
  assert.equal(b.guest_phone,'+628123456789'); assert.equal(b.notes,'Order note'); assert.equal(b.discount_reason,'Member');
  assert.equal(b.items[0].notes,'hot'); assert.equal(b.items[0].discount_value,5000); assert.equal(b.items[1].discount_value,10);
  assert.equal(b.discount_value,10); assert.equal(b.guest_name,'Owner'); assert.equal(b.reservation_id,undefined);
  for (const field of ['unit_price','price','total_amount','discount_amount','actor_user_id']) {
    assert.equal(field in b,false); assert.equal(field in b.items[0],false);
  }
});
check('Normal order without discount permission omits every discount field', () => {
  const b = D.buildPosOrderDraft(plain, details, false);
  assert.equal('discount_type' in b,false); assert.equal('discount_value' in b.items[0],false);
});
check('Zero-valued discount = no discount: no permission, no payload field', () => {
  // Keputusan #6: nilai 0 / kosong berarti TIDAK ada diskon — permission tidak
  // teraktifkan dan field diskon tidak dikirim ke payload.
  const b0 = D.buildPosOrderDraft(plain,{...details,discountType:'NOMINAL',discountInput:'0'},false);
  assert.equal('discount_type' in b0,false); assert.equal('discount_value' in b0,false);
  const bz = D.buildPosOrderDraft(plain,{...details,discountType:'PERCENT',discountInput:'0'},false);
  assert.equal('discount_type' in bz,false);
  const be = D.buildPosOrderDraft(plain,{...details,discountType:'NOMINAL',discountInput:''},false);
  assert.equal('discount_type' in be,false);
  // Item line 0 juga tidak mengirim field:
  const bl = D.buildPosOrderDraft([{...plain[0],discountType:'NOMINAL',discountInput:'0'}],details,false);
  assert.equal('discount_type' in bl.items[0],false);
});
check('Positive item-line discount still requires the separate permission', () => {
  assert.throws(() => D.buildPosOrderDraft(lines,details,false));
});
// Cases that MUST still throw (invalid non-empty values):
//  - '1.5' NOMINAL → desimal di rupiah bulat → throw
//  - '-1'  → negatif → throw
//  - '1e3' → scientific → throw
//  - '100.01' PERCENT → 3 desimal → throw
//  - '1.001' PERCENT → 3 desimal → throw
for (const [type,input] of [['NOMINAL','1.5'],['NOMINAL','-1'],['NOMINAL','1e3'],['PERCENT','100.01'],['PERCENT','1.001'],['PERCENT','NaN']])
  check('Reject invalid '+type+' discount '+JSON.stringify(input), () => assert.throws(() => D.previewPosDraft(plain,type,input)));
// Empty input = no discount (keputusan #5): tidak throw, nilai 0.
check('Empty discount input is treated as no discount, not an error', () => {
  const pNominal = D.previewPosDraft(plain,'NOMINAL','');
  assert.equal(pNominal.orderDiscount, 0);
  const pPercent = D.previewPosDraft(plain,'PERCENT','');
  assert.equal(pPercent.orderDiscount, 0);
});
check('Reject nominal above LINE or post-LINE order basis', () => {
  assert.throws(() => D.previewPosDraft([{...plain[0],discountType:'NOMINAL',discountInput:'13001'}],'',''));
  assert.throws(() => D.previewPosDraft(lines,'NOMINAL','61001'));
});
// ── Regression: input normalization & leading-zero (keputusan #3, #4) ─────
check('normalizeDiscountInput: 01→1, 0050→50, 0→0 (NOMINAL leading-zero)', () => {
  assert.equal(D.normalizeDiscountInput('01','NOMINAL'), '1');
  assert.equal(D.normalizeDiscountInput('0050','NOMINAL'), '50');
  assert.equal(D.normalizeDiscountInput('0','NOMINAL'), '0');
});
check('normalizeDiscountInput: 0.5 & 10.25 preserved (PERCENT decimal)', () => {
  assert.equal(D.normalizeDiscountInput('0.5','PERCENT'), '0.5');
  assert.equal(D.normalizeDiscountInput('10.25','PERCENT'), '10.25');
});
check('normalizeDiscountInput: 0.05→0.05, 1.001→1.00 (PERCENT 2-decimal limit)', () => {
  assert.equal(D.normalizeDiscountInput('0.05','PERCENT'), '0.05');
  assert.equal(D.normalizeDiscountInput('1.001','PERCENT'), '1.00');
});
check('normalizeDiscountInput: empty stays empty', () => {
  assert.equal(D.normalizeDiscountInput('','NOMINAL'), '');
  assert.equal(D.normalizeDiscountInput('','PERCENT'), '');
});
check('effectiveDiscount: value 0 or empty → type cleared (no discount, no permission)', () => {
  for (const [t,inp] of [['NOMINAL','0'],['NOMINAL',''],['PERCENT','0'],['PERCENT','']]) {
    const r = D.effectiveDiscount(t, inp);
    assert.equal(r.type, '', t+' '+JSON.stringify(inp)+' → type cleared');
    assert.equal(r.input, '', t+' '+JSON.stringify(inp)+' → input cleared');
  }
  // Positive value keeps type:
  const r1 = D.effectiveDiscount('NOMINAL','100');
  assert.equal(r1.type, 'NOMINAL'); assert.equal(r1.input, '100');
  const r2 = D.effectiveDiscount('PERCENT','5.5');
  assert.equal(r2.type, 'PERCENT'); assert.equal(r2.input, '5.5');
});
check('previewPosDraft: 0.5% PERCENT discount on 13000 → round(13000*0.5/100)=65', () => {
  const p = D.previewPosDraft([{...plain[0],discountType:'PERCENT',discountInput:'0.5'}],'','');
  assert.equal(p.lines[0].discount, 65);
});
check('previewPosDraft: 10.25% PERCENT order discount on 10000 → round(10000*10.25/100)=1025', () => {
  const p = D.previewPosDraft([{item:{id:1,name:'X',price:10000},qty:1}],'PERCENT','10.25');
  assert.equal(p.orderDiscount, 1025);
});
check('previewPosDraft: 100% PERCENT line discount → total 0', () => {
  const p = D.previewPosDraft([{...plain[0],discountType:'PERCENT',discountInput:'100'}],'','');
  assert.equal(p.lines[0].discount, 13000);
  assert.equal(p.total, 0);
});
check('buildPosOrderDraft: PERCENT 0 → no discount_type in payload', () => {
  const b = D.buildPosOrderDraft(plain,{...details,discountType:'PERCENT',discountInput:'0'},false);
  assert.equal('discount_type' in b, false);
  assert.equal('discount_value' in b, false);
});
check('Phone/order note/reason/line note lengths fail before POST', () => {
  for (const patch of [{guestPhone:'x'.repeat(51)},{notes:'x'.repeat(1001)},{discountReason:'x'.repeat(101)}])
    assert.throws(() => D.buildPosOrderDraft(lines,{...full,...patch},true));
  assert.throws(() => D.buildPosOrderDraft([{...plain[0],notes:'x'.repeat(1001)}],details,false));
});
check('Optional snapshots are null; reservation ID remains explicit, no canonical guest payload', () => {
  const b=D.buildPosOrderDraft(plain,{...details,guestPhone:' ',notes:' ',reservationId:99},false);
  assert.equal(b.guest_phone,null);assert.equal(b.notes,null);assert.equal(b.reservation_id,99);assert.equal('guest_id' in b,false);
});
check('Full discount preview zero is not inferred as a paid order', () => {
  assert.equal(D.previewPosDraft(plain,'PERCENT','100').total,0);
  assert.equal(D.buildPosOrderDraft(plain,{...details,discountType:'PERCENT',discountInput:'100'},true).status,undefined);
});
check('POS Edit alone cannot expose discount, separate grant requires POS Edit', () => {
  const edit={effective:{POS:{view:{allowed:true},edit:{allowed:true}}},is_platform_super_admin:false};
  assert.equal(P.getPosAccess(edit,()=>false).canDiscountPos,false);
  assert.equal(P.getPosAccess(edit,k=>k==='pos.discount.edit').canDiscountPos,true);
  const denied={...edit,effective:{POS:{view:{allowed:true},edit:{allowed:false}}}};
  assert.equal(P.getPosAccess(denied,k=>k==='pos.discount.edit').canDiscountPos,false);
  assert.equal(P.getPosAccess({...denied,is_platform_super_admin:true},()=>false).canDiscountPos,true);
});
function harness(authFetch, overrides = {}) {
  const slots = []; let cursor = 0, queued = [], tree, props;
  const react = {
    useState(initial) {const i = cursor++; if (!slots[i]) slots[i] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[i].value, value => {slots[i].value = typeof value === 'function' ? value(slots[i].value) : value;}];},
    useRef(value) {const i = cursor++; if (!slots[i]) slots[i] = {current: value}; return slots[i];},
    useCallback(fn) {cursor++; return fn;},
    useMemo(fn) {cursor++; return fn();},
    useEffect(fn, deps) {const i = cursor++, prev = slots[i];
      if (!prev || !deps || deps.some((v,k) => !Object.is(v, prev.deps[k]))) queued.push(() => {
        prev?.cleanup?.(); slots[i] = {deps, cleanup: fn()};
      });},
  };
  const jsx = (type, p, key) => ({type, props: p || {}, key});
  // Mock authenticatedFetch: return pricing-settings response immediately
  // so PosWorkspace's useEffect fetches without real network.
  // overrides.pricingData lets tests control the returned pricing settings.
  // overrides.pricingQueue (array of objects|null) = sequential pricing
  //   responses per fetch call; null entry → throw (simulate network fail).
  // overrides.onPricingFetch() → hook called on every pricing fetch.
  const _pricingData = overrides.pricingData || {
    service_charge_enabled: false, service_charge_percent: 0,
    tax_enabled: false, tax_percent: 0,
  };
  let _pricingFetchIdx = 0;
  const PRICING_FETCH_FAIL = "__FAIL__";
  const mockAuthenticatedFetch = async (_url, _init) => {
    overrides.onPricingFetch?.();
    // If a pricing queue is provided, consume it sequentially.
    // Entry === PRICING_FETCH_FAIL → simulate network failure (throw).
    if (overrides.pricingQueue) {
      const entry = overrides.pricingQueue[_pricingFetchIdx++] ?? _pricingData;
      if (entry === PRICING_FETCH_FAIL) { throw new Error('pricing fetch network error'); }
      return new Response(JSON.stringify({ status: 'OK', data: entry }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 'OK', data: _pricingData }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
    const component = load(compile('PosWorkspace.tsx'), {react, 'react/jsx-runtime': {jsx, jsxs: jsx}, './posOrderDraft': D, './GuestPicker': {default: () => null}, '../../lib/authenticatedFetch': { authenticatedFetch: mockAuthenticatedFetch }}).default;
  const signals = {created: [], pending: [], unresolved: [], pay: [], refreshes: 0};
  props = {propertyId:7,posMenu:[plain[0].item],posOrders:[],reservationId:null,authFetch,canEditPos:true,canDiscountPos:true,
    onOrderCreated(order) {signals.created.push(order);},onRequestPending(v) {signals.pending.push(v);},
    onUnresolvedChange(v) {signals.unresolved.push(v);},onOpenCashPayment(ctx) {signals.pay.push(ctx);},
    onRefresh() {signals.refreshes++;},...overrides};
  function render() {cursor = 0; tree = component(props); const effects = queued; queued = []; effects.forEach(fn => fn()); return tree;}
  function nodes() {const out = []; (function walk(n) {if (Array.isArray(n)) {n.forEach(walk); return;} if (!n || typeof n !== 'object') return;
    out.push(n); walk(n.props?.children);})(tree); return out;}
  function label(n) {const flatten = v => Array.isArray(v) ? v.map(flatten).join('') : v && typeof v === 'object' ? flatten(v.props?.children) : v == null ? '' : String(v); return flatten(n.props.children);}
  function button(text) {const n = nodes().find(n => n.type === 'button' && label(n) === text); assert.ok(n, 'Missing button ' + text); return n;}
  function click(text) {const n = button(text); assert.equal(!!n.props.disabled, false, 'Disabled button ' + text); n.props.onClick(); render();}
  // Like click but does NOT assert enabled — used to test buttons that are
  // intentionally disabled (e.g. during pricing loading/error).
  function clickIfEnabled(text) {const n = button(text); if (!n.props.disabled) {n.props.onClick(); render();}}
  // Call onClick DIRECTLY even when the button is disabled — bypasses the
  // disabled guard so handler-level safeguards can be regression-tested.
  function forceClick(text) {const n = button(text); n.props.onClick(); render();}
  function byAria(name,value) {const n=nodes().find(n=>n.props['aria-label']===name && (n.type==='input'||n.type==='select'));
    assert.ok(n,'Missing input '+name);assert.equal(!!n.props.disabled,false);n.props.onChange({target:{value}});render();}
  function labelled(name,value) {const l=nodes().find(n=>n.type==='label'&&label(n).includes(name));assert.ok(l,'Missing label '+name);
    const children=Array.isArray(l.props.children)?l.props.children:[l.props.children];const n=children.find(n=>n&&typeof n==='object'&&['input','textarea','select'].includes(n.type));
    assert.ok(n);assert.equal(!!n.props.disabled,false);n.props.onChange({target:{value}});render();}
  function addItem() {const n=nodes().find(n=>n.type==='div'&&typeof n.props.onClick==='function'&&label(n).includes('Coffee'));assert.ok(n,'Missing menu Coffee');assert.equal(!!n.props.disabled,false);n.props.onClick();render();}
  async function settle() {await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render();}
  render(); return {render,nodes,button,click,clickIfEnabled,forceClick,byAria,labelled,addItem,settle,signals,
    changeProps(patch) {props={...props,...patch};render();},
    cleanup() {slots.forEach(s=>s?.cleanup?.());}};
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const created=(body,status=201)=>json({status:status===201?'SUCCESS':'REPLAY',data:{id:9,property_id:body.property_id,
  reservation_id:body.reservation_id??null,order_number:'POS-7',status:'OPEN',total_amount:'10000',guest_name:body.guest_name,
  guest_phone:body.guest_phone,notes:body.notes}},status);
async function lifecycle() {
  let requests=[],h;
  h=harness(async(_url,init)=>{const body=JSON.parse(init.body);requests.push({body,init});return created(body);},{canDiscountPos:false});
  h.addItem();h.labelled('Nomor WhatsApp','+628123456789');h.labelled('Catatan pesanan','Order note');h.byAria('Catatan Coffee','hot');
  await h.settle();h.click('Bayar');await h.settle();
  check('Workspace ordinary Bayar sends snapshots with no discounts/prices; payment uses server amount',()=>{
    assert.equal(requests.length,1);const b=requests[0].body;assert.equal(b.guest_phone,'+628123456789');assert.equal(b.notes,'Order note');assert.equal(b.items[0].notes,'hot');
    assert.equal('unit_price' in b.items[0],false);assert.equal('discount_type' in b,false);
    assert.equal(b.service_charge_enabled,false);assert.equal(b.tax_enabled,false);
    assert.equal(h.signals.created.length,1);assert.equal(h.signals.pay.length,1);assert.equal(h.signals.pay[0].totalAmount,'10000');
    assert.equal(h.nodes().some(n=>n.props['aria-label']==='Nilai diskon Coffee'),false);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(JSON.parse(init.body));return created(requests.at(-1));});h.addItem();
  // Default satuan item = PERCENT (%). Set Rp eksplisit sebelum nominal 1000.
  h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','1000');h.byAria('Satuan diskon pesanan','%');
  h.byAria('Nilai diskon pesanan','10');h.byAria('Alasan diskon pesanan','member');await h.settle();h.click('Simpan Pesanan');await h.settle();
  check('Workspace granted discount emits LINE then order fields; save alone never opens pay',()=>{
    assert.equal(requests[0].items[0].discount_type,'NOMINAL');assert.equal(requests[0].items[0].discount_value,1000);
    assert.equal(requests[0].discount_type,'PERCENT');assert.equal(requests[0].discount_value,10);assert.equal(requests[0].discount_reason,'member');
    assert.equal(h.signals.created.length,1);assert.equal(h.signals.pay.length,0);
  });h.cleanup();
  requests=[];let attempt=0;
  h=harness(async(_url,init)=>{requests.push({body:init.body,key:init.headers['Idempotency-Key']});
    if(++attempt===1)throw new Error('network');if(attempt===2)return json({code:'DISCOUNT_PERMISSION_DENIED'},403);return created(JSON.parse(init.body),200);});
  h.addItem();h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','1000');h.labelled('Nomor WhatsApp','+628123');
  h.labelled('Catatan pesanan','same order');await h.settle();h.click('Simpan Pesanan');await h.settle();
  check('Workspace ambiguous locks phone/note/discount drafts and keeps result unresolved',()=>{
    assert.equal(h.signals.created.length,0);assert.equal(h.signals.unresolved.at(-1),true);
    assert.equal(h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee').props.disabled,true);
    assert.equal(h.nodes().find(n=>n.type==='textarea').props.disabled,true);
  });h.changeProps({canDiscountPos:false});h.click('Coba Lagi');await h.settle();
  check('Workspace revoked discount retry keeps identical key/body and unresolved',()=>{
    assert.equal(requests[1].body,requests[0].body);assert.equal(requests[1].key,requests[0].key);
    assert.equal(h.signals.unresolved.at(-1),true);assert.equal(h.signals.created.length,0);
  });h.changeProps({canDiscountPos:true});h.click('Coba Lagi');await h.settle();
  check('Workspace regrant replay resolves same snapshot without rebuilding',()=>{
    assert.equal(requests[2].body,requests[0].body);assert.equal(requests[2].key,requests[0].key);
    assert.equal(h.signals.created.length,1);assert.equal(h.signals.unresolved.at(-1),false);
  });h.cleanup();
  for(const scope of ['property','reservation']){
    requests=[];h=harness(async(_url,init)=>{requests.push(init.body);throw new Error('network');});h.addItem();await h.settle();h.click('Simpan Pesanan');await h.settle();
    h.changeProps(scope==='property'?{propertyId:8}:{reservationId:99});if(scope==='property')await h.settle();h.click('Coba Lagi');await h.settle();
    check('Workspace '+scope+' change cannot retarget unresolved create',()=>{
      assert.equal(requests.length,1);assert.equal(h.signals.unresolved.at(-1),true);assert.equal(h.signals.created.length,0);
    });h.cleanup();
  }
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});h.addItem();
  h.byAria('Satuan diskon Coffee','%');h.byAria('Nilai diskon Coffee','100');
  await h.settle();
  check('Workspace zero-total Bayar disabled; ordinary save still separate',()=>{
    assert.equal(h.button('Bayar').props.disabled,true);assert.equal(h.button('Simpan Pesanan').props.disabled,false);assert.equal(requests.length,0);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return json({status:'SUCCESS',data:{id:9,property_id:8,order_number:'FOREIGN',status:'OPEN',total_amount:'13000'}},201);});
  h.addItem();await h.settle();h.click('Bayar');await h.settle();
  check('Workspace malformed scope in success stays unresolved and does not open payment',()=>{
    assert.equal(h.signals.created.length,0);assert.equal(h.signals.pay.length,0);assert.equal(h.signals.unresolved.at(-1),true);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});h.addItem();
  h.labelled('Nomor WhatsApp','x'.repeat(51));await h.settle();h.click('Simpan Pesanan');await h.settle();
  check('Workspace invalid input fails before pending/POST; draft remains editable',()=>{
    assert.equal(requests.length,0);assert.equal(h.signals.pending.includes(true),false);
    assert.equal(h.nodes().find(n=>n.type==='textarea').props.disabled,false);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});h.addItem();
  h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','1000');h.changeProps({canDiscountPos:false});
  await h.settle();
  check('Workspace permission lost retains draft and offers explicit removal',()=>assert.equal(h.button('Simpan Pesanan').props.disabled,true));
  h.click('Hapus semua diskon');h.click('Simpan Pesanan');await h.settle();
  check('Workspace explicit removal preserves items and sends ordinary order',()=>{
    assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0]).items.length,1);assert.equal('discount_type' in JSON.parse(requests[0]).items[0],false);
  });h.cleanup();
  // ── Regression: input normalisasi diskon UI (0→1, 0→5, 01→1, 0050→50, toggle Rp/%) ─
  {
    let reqs=[];
    h=harness(async(_url,init)=>{reqs.push(JSON.parse(init.body));return created(reqs.at(-1));});
    h.addItem();await h.settle();
    // Skenario nyata: input awal kosong (placeholder "0").
    // User fokus → select-all otomatis. Tekan End (cancel select-all, cursor
    // ke akhir). Ketik "1" → teks asli menjadi "01". Normalisasi WAJUB jadi "1".
    // Skenario ini mensimulasikan apa yang sebenarnya terjadi di DOM:
    //   initial state: value='' + placeholder='0'
    //   user fokus:    select-all pada string kosong (tidak ada efek)
    //   user ketik '1':e.target.value = '1' (input kosong → '1', bukan '01')
    //   user append '1' ke '0': e.target.value = '01' → normalisasi → '1'
    h.byAria('Nilai diskon Coffee','0');await h.settle();
    check('UI input: ketik 0 → tersimpan "0" (= tanpa diskon)',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'0');
    });
    // User menekan End, lalu mengetik '1' tanpa select-all → teks asli = '01'
    h.byAria('Nilai diskon Coffee','01');await h.settle();
    check('UI input: 0 lalu append 1 → normalisasi menjadi "1" (bukan "01")',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'1');
    });
    // User append '5' ke '0' → teks asli = '05' → normalisasi '5'
    h.byAria('Nilai diskon Coffee','05');await h.settle();
    check('UI input: 0 lalu append 5 → normalisasi menjadi "5"',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'5');
    });
    // 0050 → 50: normalisasi multi leading-zero
    h.byAria('Nilai diskon Coffee','0050');await h.settle();
    check('UI input: 0050 → normalisasi menjadi "50"',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'50');
    });
    // Default satuan sekarang PERCENT (%). Toggle ke % (unit yang sama) TIDAK
    // me-reset nilai (perilaku yang disetujui: hanya satuan BERUBAH me-reset).
    // Nilai '50' dari 0050 masih tersimpan.
    h.byAria('Satuan diskon Coffee','%');await h.settle();
    check('UI input: satuan sudah % → toggle % tidak me-reset nilai',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'50','nilai tetap 50 — satuan tidak berubah');
      const unit=h.nodes().find(n=>n.props['aria-label']==='Satuan diskon Coffee');
      assert.equal(unit.props.value,'%');
    });
    // Toggle ke Rp → satuan BERUBAH → nilai di-reset.
    h.byAria('Satuan diskon Coffee','Rp');await h.settle();
    check('UI input: toggle Rp (satuan berubah) mereset nilai ke kosong',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'');
      const unit=h.nodes().find(n=>n.props['aria-label']==='Satuan diskon Coffee');
      assert.equal(unit.props.value,'Rp');
    });
    // Toggle kembali ke % → satuan BERUBAH → reset lagi.
    h.byAria('Satuan diskon Coffee','%');await h.settle();
    check('UI input: toggle kembali % (satuan berubah) mereset nilai',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'');
      const unit=h.nodes().find(n=>n.props['aria-label']==='Satuan diskon Coffee');
      assert.equal(unit.props.value,'%');
    });
    h.byAria('Nilai diskon Coffee','0.5');await h.settle();
    check('UI input: 0.5% tersimpan sebagai "0.5" (tidak diubah)',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'0.5');
    });
    // 10.25% tetap valid
    h.byAria('Nilai diskon Coffee','10.25');await h.settle();
    check('UI input: 10.25% tersimpan sebagai "10.25" (tidak diubah)',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'10.25');
    });
    // Toggle kembali ke Rp mereset nilai
    h.byAria('Satuan diskon Coffee','Rp');await h.settle();
    check('UI input: toggle Rp mereset nilai ke kosong',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'');
      const unit=h.nodes().find(n=>n.props['aria-label']==='Satuan diskon Coffee');
      assert.equal(unit.props.value,'Rp');
    });
    // Input kosong → tanpa diskon, payload tidak mengirim field
    h.click('Simpan Pesanan');await h.settle();
    check('UI input: nilai kosong → payload tanpa diskon',()=>{
      const b=reqs[0];
      assert.equal('discount_type' in b,false,'Order discount field tidak ada');
      assert.equal('discount_value' in b,false,'Order discount value tidak ada');
      assert.equal('discount_type' in b.items[0],false,'Item discount field tidak ada');
    });
    h.cleanup();
  }
  // ── Regression: nilai tidak valid TIDAK diubah diam-diam menjadi valid ─────
  {
    let reqs=[];
    h=harness(async(_url,init)=>{reqs.push(JSON.parse(init.body));return created(reqs.at(-1));});
    h.addItem();await h.settle();
    // NOMINAL '1.5' (desimal) → tetap '1.5' setelah normalisasi → preview error.
    // Default satuan sekarang PERCENT (%), jadi WAJIB pilih Rp eksplisit dulu
    // agar '1.5' diinterpretasikan sebagai 1.5 Rupiah (invalid: Rp bulat),
    // bukan sebagai 1.5% (yang valid dan tidak menghasilkan error).
    h.byAria('Satuan diskon Coffee','Rp');
    h.byAria('Nilai diskon Coffee','1.5');await h.settle();
    check('UI input: NOMINAL "1.5" → preview error, Simpan disabled (tidak diubah jadi "1")',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'1.5','nilai tetap 1.5, tidak dihapus diam-diam');
      const pNodes=h.nodes().filter(n=>n.type==='p'&&typeof n.props.children==='string');
      assert.ok(pNodes.some(p=>p.props.children.includes('rupiah')||p.props.children.includes('Periksa')||p.props.children.includes('bulat')),
        'Pesan error preview tampil');
      assert.equal(h.button('Simpan Pesanan').props.disabled,true,'Simpan disabled saat input tidak valid');
    });
    // NOMINAL '-1' (negatif) → tetap '-1' → preview error (masih satuan Rp).
    h.byAria('Nilai diskon Coffee','-1');await h.settle();
    check('UI input: NOMINAL "-1" → preview error, Simpan disabled (tidak diubah jadi "1")',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'-1','nilai tetap -1, tidak diubah secara diam-diam');
      assert.equal(h.button('Simpan Pesanan').props.disabled,true);
    });
    // PERCENT '1.001' → normalisasi membatasi 2 desimal menjadi '1.00'
    h.byAria('Satuan diskon Coffee','%');await h.settle();
    h.byAria('Nilai diskon Coffee','1.001');await h.settle();
    check('UI input: PERCENT "1.001" → normalisasi membatasi 2 desimal → "1.00"',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'1.00','3 desimal dipangkas menjadi 2 desimal');
    });
    // Karakter tidak valid dalam desimal persen tidak dihapus diam-diam.
    // "1.a5" → tetap "1.a5" → preview error, Simpan disabled.
    h.byAria('Nilai diskon Coffee','1.a5');await h.settle();
    check('UI input: PERCENT "1.a5" → tidak dihapus diam-diam, Simpan disabled',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'1.a5','huruf a tidak dihapus');
      assert.equal(h.button('Simpan Pesanan').props.disabled,true);
    });
    // "1.-5" → tetap "1.-5" → preview error.
    h.byAria('Nilai diskon Coffee','1.-5');await h.settle();
    check('UI input: PERCENT "1.-5" → tidak dihapus diam-diam, Simpan disabled',()=>{
      const node=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.equal(node.props.value,'1.-5','tanda minus tidak dihapus');
      assert.equal(h.button('Simpan Pesanan').props.disabled,true);
    });
    h.cleanup();
  }
  // ── Regression: diskon lebih besar dari basis ditolak ──────────────────────
  {
    let reqs=[];
    h=harness(async(_url,init)=>{reqs.push(JSON.parse(init.body));return created(reqs.at(-1));});
    h.addItem();await h.settle();
    // Set Rp eksplisit (default sekarang PERCENT; 99999 Rp > basis → throw).
    h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','99999');await h.settle();
    check('UI input: diskon > basis → preview error, Simpan disabled',()=>{
      const pNodes=h.nodes().filter(n=>n.type==='p'&&typeof n.props.children==='string');
      assert.ok(pNodes.some(p=>p.props.children.includes('melampaui')||p.props.children.includes('diskon')||p.props.children.includes('Periksa')),
        'Pesan error draftPreview tampil');
      assert.equal(h.button('Simpan Pesanan').props.disabled,true,'Simpan disabled saat preview error');
    });
    // Nilai valid (Rp 1000 pada basis 13000) → preview OK
    h.byAria('Nilai diskon Coffee','1000');await h.settle();
    check('UI input: diskon valid → preview OK, Simpan enabled',()=>{
      assert.equal(h.button('Simpan Pesanan').props.disabled,false,'Simpan enabled saat diskon valid');
    });
    h.cleanup();
  }
  // ── Regression: permission diskon ─────────────────────────────────────────
  {
    let reqs=[];
    h=harness(async(_url,init)=>{reqs.push(JSON.parse(init.body));return created(reqs.at(-1));},{canDiscountPos:false});
    h.addItem();await h.settle();
    check('UI: canDiscountPos=false → input diskon tidak tampil',()=>{
      assert.equal(h.nodes().some(n=>n.props['aria-label']==='Nilai diskon Coffee'),false);
    });
    h.cleanup();
  }
  // ── Regression: pricing loading guard ─────────────────────────────────────
  // Saat pricing settings masih 'loading', tombol submit harus disabled.
  // Setelah settle (pricing ready), tombol enabled kembali.
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});
  h.addItem();
  check('Pricing loading guard blocks submit while settings load',()=>{
    assert.equal(h.button('Simpan Pesanan').props.disabled,true,'Simpan disabled while pricing loads');
    assert.equal(requests.length,0);
  });
  await h.settle();
  check('Pricing loading guard lifts after settings load',()=>{
    assert.equal(h.button('Simpan Pesanan').props.disabled,false,'Simpan enabled after pricing ready');
  });
  h.cleanup();
  // ── Regression: payload svc/tax consistency (property OFF → false) ────────
  // Saat properti svc/tax OFF, payload WAJIB mengirim false eksplisit,
  // bukan omit (backward compat) atau true (stale).
  requests=[];h=harness(async(_url,init)=>{requests.push(JSON.parse(init.body));return created(requests.at(-1));});
  h.addItem();
  await h.settle();
  h.click('Simpan Pesanan');await h.settle();
  check('Payload svc/tax fields explicit false when property OFF',()=>{
    assert.equal(requests.length,1);
    assert.equal(requests[0].service_charge_enabled,false,'svc must be false when property OFF');
    assert.equal(requests[0].tax_enabled,false,'tax must be false when property OFF');
    assert.equal(h.signals.created.length,1);
  });
  h.cleanup();
  // ── Regression: toggle reset setelah order sukses ─────────────────────────
  // Properti svc ON & tax ON: setelah order sukses, toggle di-reset ke nilai
  // properti (ON), bukan ke OFF paksa. Draft baru → toggle ON sesuai properti.
  requests=[];h=harness(async(_url,init)=>{requests.push(JSON.parse(init.body));return created(requests.at(-1));},
    {pricingData:{service_charge_enabled:true,service_charge_percent:10,tax_enabled:true,tax_percent:11}});
  h.addItem();await h.settle();
  h.click('Simpan Pesanan');await h.settle();
  check('Toggle reset to property default (ON) after successful order — first payload',()=>{
    assert.equal(requests.length,1);
    // Payload pertama: svc & tax ON (toggle ON + properti ON → effective ON)
    assert.equal(requests[0].service_charge_enabled,true,'svc ON when property ON and toggle ON');
    assert.equal(requests[0].tax_enabled,true,'tax ON when property ON and toggle ON');
    assert.equal(h.signals.created.length,1);
  });
  // Tambah item kedua: draft baru, toggle harus ON (reset ke default properti)
  h.addItem();await h.settle();
  h.click('Simpan Pesanan');await h.settle();
  check('Toggle reset to property default (ON) — second payload after reset',()=>{
    assert.equal(requests.length,2);
    assert.equal(requests[1].service_charge_enabled,true,'svc stays ON after reset (property default)');
    assert.equal(requests[1].tax_enabled,true,'tax stays ON after reset (property default)');
  });
  h.cleanup();
  // ── Regression: HTTP 400 pricing — draft dipertahankan, tidak auto-retry ─
  // authFetch pertama return 400 SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY.
  // Diharapkan: cart & diskon TIDAP dihapus, snapshot dibuang, tidak ada
  // request kedua otomatis (tidak auto-retry), message error tampil.
  requests=[];let attempt400=0;
  h=harness(async(_url,init)=>{
    attempt400++;requests.push(JSON.parse(init.body));
    if(attempt400===1) return json({status:'ERROR',code:'SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY',message:'Service charge di properti ini dimatikan.'},400);
    return created(requests.at(-1));
  },{pricingData:{service_charge_enabled:false,service_charge_percent:0,tax_enabled:false,tax_percent:0}});
  h.addItem();h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','500');
  await h.settle();
  h.click('Simpan Pesanan');await h.settle();
  check('HTTP 400 pricing: draft preserved, no auto-retry, error message shown',()=>{
    assert.equal(attempt400,1,'Hanya 1 request — tidak ada auto-retry');
    // Cart masih ada (draft dipertahankan)
    assert.equal(h.nodes().some(n=>n.props['aria-label']==='Nilai diskon Coffee'),true,'Diskon item masih ada');
    // Error message tampil — saveResult.message di-render sebagai <p>
    const errNodes=h.nodes().filter(n=>n.type==='p'&&typeof n.props.children==='string'&&n.props.children.includes('Service charge'));
    assert.ok(errNodes.length>0,'Pesan error pricing 400 tampil');
    // Snapshot dibuang → tombol Simpan Pesanan enabled lagi (bukan terkunci)
    assert.equal(h.button('Simpan Pesanan').props.disabled,false,'Tombol Simpan enabled setelah 400 pricing definitif');
  });
  h.cleanup();

  // ── Regression TEMUAN 1: PRICING_TOTAL_CHANGED + snapshot unresolved ──────
  // Alur: network error pertama → snapshot unresolved/locked → "Coba Lagi"
  // dipaksa backend return 409 PRICING_TOTAL_CHANGED. Diharapkan:
  // - snapshot TIDAK dibuang (idempotency key + payload asli dipertahankan)
  // - status unresolved/locked dipertahankan (onUnresolvedChange tetap true)
  // - retry berikutnya ("Coba Lagi" lagi) memakai KEY & BODY yang sama
  //   (tidak membuat key baru sebelum hasil pengajuan lama dipastikan)
  // - tidak ada submit otomatis, cart & diskon tetap ada
  requests=[];let attemptPtc=0;
  h=harness(async(_url,init)=>{
    attemptPtc++;
    const key=init.headers['Idempotency-Key'];
    requests.push({body:init.body,key});
    if(attemptPtc===1) throw new Error('network'); // → unresolved
    if(attemptPtc===2) return json({status:'ERROR',code:'PRICING_TOTAL_CHANGED',message:'Total berubah',data:{computed_total:45000,expected_total:40000,service_charge_percent:10,tax_percent:11}},409);
    return created(JSON.parse(init.body));
  },{pricingData:{service_charge_enabled:true,service_charge_percent:10,tax_enabled:true,tax_percent:11}});
  h.addItem();h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','500');
  await h.settle();
  h.click('Simpan Pesanan');await h.settle(); // attempt 1 → network → unresolved
  h.click('Coba Lagi');await h.settle();       // attempt 2 → 409 PTC (unresolved)
  check('PTC + unresolved: snapshot & key dipertahankan, status locked',()=>{
    assert.equal(attemptPtc,2,'Tidak ada auto-retry setelah 409 PTC');
    assert.equal(h.signals.unresolved.at(-1),true,'Snapshot tetap unresolved/locked setelah 409 PTC');
    // Cart & diskon masih ada
    assert.equal(h.nodes().some(n=>n.props['aria-label']==='Nilai diskon Coffee'),true,'Diskon item masih ada');
  });
  // Retry ketiga: karena snapshot masih unresolved, harus memakai KEY & BODY
  // yang sama (replay snapshot), TIDAK membuat key baru.
  h.click('Coba Lagi');await h.settle(); // attempt 3 → created (replay sukses)
  check('PTC + unresolved: retry berikutnya memakai key & body snapshot lama',()=>{
    assert.equal(attemptPtc,3);
    assert.equal(requests[2].key,requests[1].key,'Key idempotensi sama — snapshot dipertahankan, bukan key baru');
    assert.equal(requests[2].body,requests[1].body,'Body payload sama — payload asli dipertahankan');
    assert.equal(h.signals.created.length,1,'Replay setelah resolusi menghasilkan order');
    assert.equal(h.signals.unresolved.at(-1),false,'Unresolved dilepas setelah sukses');
  });
  h.cleanup();

  // ── Regression TEMUAN 2: HTTP 400 pricing re-fetch berhasil ──────────────
  // Alur: authFetch return 400 SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY →
  // pricing settings di-set 'loading' (blokir Simpan) → re-fetch via
  // authenticatedFetch return svc ON 15% / tax ON 10% → sinkronkan
  // master flag, persentase & toggle → Simpan enabled kembali dengan
  // nilai properti TERBARU (bukan nilai lama yang memicu 400).
  // Menggunakan mutable pricingMock: pricing fetch pertama = lama (svc ON),
  // pricing fetch re-fetch = baru (svc OFF 0% / tax OFF 0%).
  {
    const pricingQueue=[
      {service_charge_enabled:true,service_charge_percent:15,tax_enabled:true,tax_percent:10},
      {service_charge_enabled:false,service_charge_percent:0,tax_enabled:true,tax_percent:10},
    ];
    let pricingFetches=0;
    requests=[];let attemptRf=0;
    h=harness(async(_url,init)=>{
      attemptRf++;requests.push(JSON.parse(init.body));
      if(attemptRf===1) return json({status:'ERROR',code:'SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY',message:'Service charge di properti ini dimatikan.'},400);
      return created(requests.at(-1));
    },{
      pricingData:{service_charge_enabled:true,service_charge_percent:15,tax_enabled:true,tax_percent:10},
      // Override mockAuthenticatedFetch via closure: sequential pricing queue.
      pricingQueue,
      onPricingFetch() {pricingFetches++;},
    });
    h.addItem();
    await h.settle(); // pricing fetch #1 (queue[0]: svc ON 15%)
    // Simpan saat ini: svc ON (toggle ON + properti ON) → payload svc ON
    // → backend 400 (properti svc OFF sekarang).
    h.click('Simpan Pesanan');await h.settle(); // 400 → re-fetch selesai (queue[1])
    // Re-fetch selesai: pricing ready dengan nilai queue[1]
    // (svc OFF 0% / tax ON 10%) — Simpan kembali enabled.
    check('400 re-fetch berhasil: Simpan enabled, re-fetch dipanggil, tidak auto-retry',()=>{
      assert.equal(attemptRf,1,'Tidak ada auto-retry setelah 400');
      assert.equal(pricingFetches,2,'Re-fetch pricing dipanggil 1x tambahan (initial + refetch)');
      assert.equal(h.button('Simpan Pesanan').props.disabled,false,'Simpan enabled setelah re-fetch ready');
      // Cart masih ada (dish) — input diskon selalu terlihat bila canDiscountPos,
      // tetapi nilai diskon belum di-set (tanpa diskon di draft ini).
      const discNode=h.nodes().find(n=>n.props['aria-label']==='Nilai diskon Coffee');
      assert.ok(discNode,'Input diskon item tersedia');
      assert.equal(discNode.props.value,'','Nilai diskon kosong = tanpa diskon');
    });
    // Submit lagi: toggle svc sekarang OFF (sinkron ke properti baru)
    // → payload svc OFF → backend accept.
    h.click('Simpan Pesanan');await h.settle();
    check('400 re-fetch: payload berikutnya memakai flag properti terbaru',()=>{
      assert.equal(attemptRf,2,'Hanya 1 request kedua manual (tanpa auto-submit)');
      assert.equal(requests[1].service_charge_enabled,false,'svc OFF sesuai properti terbaru');
      assert.equal(requests[1].tax_enabled,true,'tax ON sesuai properti terbaru');
      assert.equal(h.signals.created.length,1);
    });
    h.cleanup();
  }

  // ── Regression TEMUAN 2b: HTTP 400 pricing re-fetch GAGAL → Muat Ulang ───
  // Alur: 400 TAX_NOT_ENABLED_AT_PROPERTY → re-fetch via authenticatedFetch
  // GAGAL (network) → pricing status 'error' → Simpan TETAP BLOCKED.
  // Tombol "Muat Ulang" muncul untuk re-trigger fetch secara manual.
  // Setelah Muat Ulang sukses, pricing ready, Simpan enabled, payload
  // berikutnya memakai flag properti terbaru.
  // Cart, diskon & input kasir dipertahankan sepanjang proses.
  {
    const pricingQueue=[
      {service_charge_enabled:true,service_charge_percent:15,tax_enabled:true,tax_percent:10},
      "__FAIL__", // fetch kedua (auto re-fetch setelah 400) → throw
      {service_charge_enabled:false,service_charge_percent:0,tax_enabled:false,tax_percent:0},
    ];
    let pricingFetches=0;
    requests=[];let attemptRf2=0;
    h=harness(async(_url,init)=>{
      attemptRf2++;requests.push(JSON.parse(init.body));
      if(attemptRf2===1) return json({status:'ERROR',code:'TAX_NOT_ENABLED_AT_PROPERTY',message:'Pajak di properti ini dimatikan.'},400);
      return created(requests.at(-1));
    },{
      pricingData:{service_charge_enabled:true,service_charge_percent:15,tax_enabled:true,tax_percent:10},
      pricingQueue,
      onPricingFetch() {pricingFetches++;},
    });
    h.addItem();h.byAria('Satuan diskon Coffee','Rp');h.byAria('Nilai diskon Coffee','700');
    h.labelled('Catatan pesanan','catatan penting');
    await h.settle();
    h.click('Simpan Pesanan');await h.settle(); // 400 → auto re-fetch gagal (queue[1]="__FAIL__")
    // Wait async pricing refresh: settle hingga React state stabil
    // (loading → error). 2x setImmediate + 2x render per settle.
    await h.settle();
    check('400 re-fetch gagal: pricing error, Simpan & Bayar benar-benar disabled',()=>{
      assert.equal(attemptRf2,1,'Tidak ada auto-retry / auto-submit');
      assert.equal(pricingFetches,2,'Fetch awal + auto re-fetch (gagal)');
      // Assertion wajib: Simpan disabled saat pricing berstatus error.
      assert.equal(h.button('Simpan Pesanan').props.disabled,true,'Simpan disabled saat pricing error');
      // Bayar juga diblokir (guard yang sama: canSaveDraft memblokir keduanya).
      assert.equal(h.button('Bayar').props.disabled,true,'Bayar disabled saat pricing error');
      // Cart & input kasir dipertahankan
      assert.equal(h.nodes().some(n=>n.props['aria-label']==='Nilai diskon Coffee'),true,'Diskon item dipertahankan');
      assert.ok(h.nodes().find(n=>n.type==='textarea'),'Input catatan masih ada');
    });
    // Klik paksa Simpan (bypass tombol disabled) saat pricing error:
    // handler guard WAJIB menolak — tidak ada POST order baru.
    // Targetkan tombol dengan label persis "Simpan Pesanan" (bukan tombol
    // disabled pertama yang kebetulan ditemukan), lalu panggil onClick
    // secara langsung tanpa if yang bisa melewatkan simulasi.
    const simpanNode = h.button('Simpan Pesanan');
    check('Klik paksa: tombol Simpan Pesanan ditemukan, disabled, onClick function',()=>{
      assert.ok(simpanNode,'Tombol Simpan Pesanan ditemukan');
      assert.equal(simpanNode.props.disabled,true,'Simpan Pesanan disabled saat pricing error');
      assert.equal(typeof simpanNode.props.onClick,'function','Simpan Pesanan onClick adalah function');
    });
    h.forceClick('Simpan Pesanan'); // panggil handler langsung — bypass disabled
    await h.settle();
    check('Klik paksa Simpan saat pricing error TIDAK menghasilkan POST order baru',()=>{
      assert.equal(attemptRf2,1,'Tidak ada request POST baru (guard handler pricing aktif)');
      assert.equal(h.signals.created.length,0,'Tidak ada order dibuat saat pricing error');
    });
    // Klik "Muat Ulang" → fetch ketiga (queue[2]: svc OFF / tax OFF)
    const muatUlangBtn=h.nodes().find(n=>n.type==='button' && (n.props.children?.includes?.('Muat Ulang') || (typeof n.props.children==='string' && n.props.children.includes('Muat Ulang'))));
    check('Tombol Muat Ulang tampil saat pricing error',()=>{
      assert.ok(muatUlangBtn,'Tombol Muat Ulang ada di UI');
    });
    muatUlangBtn.props.onClick();await h.settle();
    check('Muat Ulang berhasil: pricing ready, Simpan enabled',()=>{
      assert.equal(pricingFetches,3,'Fetch ketiga via Muat Ulang');
      assert.equal(h.button('Simpan Pesanan').props.disabled,false,'Simpan enabled setelah Muat Ulang sukses');
    });
    // Submit lagi: toggle svc/tax sinkron ke properti baru (OFF/OFF)
    h.click('Simpan Pesanan');await h.settle();
    check('Muat Ulang: payload berikutnya memakai flag properti terbaru',()=>{
      assert.equal(attemptRf2,2,'Hanya 1 request kedua manual');
      assert.equal(requests[1].service_charge_enabled,false,'svc OFF sesuai properti terbaru');
      assert.equal(requests[1].tax_enabled,false,'tax OFF sesuai properti terbaru');
      assert.equal(h.signals.created.length,1);
    });
    h.cleanup();
  }

  // ── Regression: Nilai awal CREATE kosong, pindah tab mempertahankan draft, metadata existing, & Refresh di PosModal ─
  {
    let reqs = [];
    h = harness(async (url, init) => {
      if (!init || !init.method || init.method === 'GET') {
        return json({
          status: 'SUCCESS',
          data: {
            order: {
              id: 55,
              property_id: 7,
              order_number: 'POS-55',
              status: 'OPEN',
              version: 2,
              total_amount: 26000,
              subtotal_amount: 26000,
              table_number: 'VIP-2',
              guest_name: 'Siti Aminah',
              guest_phone: '08111222333',
              notes: 'Pedas sedang',
              discount_type: null,
              discount_value: null,
              discount_amount: 0,
              discount_reason: null,
              service_charge_percent_snapshot: 0,
              service_charge_amount: 0,
              tax_percent_snapshot: 0,
              tax_amount: 0,
            },
            items: [
              {
                id: 501,
                menu_item_id: 1,
                quantity: 2,
                unit_price: 13000,
                subtotal_amount: 26000,
                notes: 'hangat',
                discount_type: null,
                discount_value: null,
                discount_amount: 0,
                item_name_snapshot: 'Coffee',
                item_code_snapshot: 'CF-01',
              },
            ],
          },
        }, 200);
      }
      const b = JSON.parse(init.body);
      reqs.push(b);
      return created(b);
    }, {
      posOrders: [
        { id: 55, order_number: 'POS-55', status: 'OPEN', total_amount: '26000', table_number: 'VIP-2', guest_name: 'Siti Aminah' },
      ],
    });
    await h.settle();

    const findInputUnderLabel = (lblText) => {
      const container = h.nodes().find(n => n.type === 'div' && Array.isArray(n.props.children) &&
        n.props.children.some(c => c && c.type === 'label' && String(c.props?.children || '').includes(lblText)));
      assert.ok(container, 'Missing container for label ' + lblText);
      const inp = container.props.children.find(c => c && c.type === 'input');
      assert.ok(inp, 'Missing input for label ' + lblText);
      return inp;
    };

    check('CREATE initial values: Nomor Meja & Nama Tamu empty with placeholders, intro banner removed', () => {
      const tableInp = findInputUnderLabel('Nomor Meja');
      const guestInp = findInputUnderLabel('Nama Tamu');
      assert.equal(tableInp.props.value, '', 'Nomor Meja awalnya kosong');
      assert.equal(guestInp.props.value, '', 'Nama Tamu awalnya kosong');
      assert.ok(typeof tableInp.props.placeholder === 'string' && tableInp.props.placeholder.length > 0, 'Placeholder Nomor Meja ada');
      assert.ok(typeof guestInp.props.placeholder === 'string' && guestInp.props.placeholder.length > 0, 'Placeholder Nama Tamu ada');
      const hasIntroText = h.nodes().some(n => typeof n.props?.children === 'string' &&
        (n.props.children.includes('Departemen Operasional POS') || n.props.children.includes('Point of Sale (POS) & F&B')));
      assert.equal(hasIntroText, false, 'Kotak pengantar tidak dirender di PosWorkspace');
      const workspaceRefresh = h.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Refresh Data');
      assert.equal(workspaceRefresh, undefined, 'Tombol refresh tidak ada lagi di dalam PosWorkspace');
    });

    h.addItem();
    await h.settle();
    h.click('Simpan Pesanan');
    await h.settle();
    check('CREATE save with empty table/guest sends null (no Table 1 / Walk-in Guest default)', () => {
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0].table_number, null, 'table_number adalah null saat kosong');
      assert.equal(reqs[0].guest_name, null, 'guest_name adalah null saat kosong');
    });

    h.addItem();
    findInputUnderLabel('Nomor Meja').props.onChange({ target: { value: 'Meja 7' } });
    h.render();
    findInputUnderLabel('Nama Tamu').props.onChange({ target: { value: 'Andi' } });
    h.render();
    h.labelled('Catatan pesanan', 'Tanpa es');
    h.click('Riwayat Order (1)');
    h.click('Kasir & Menu POS');
    check('CREATE active draft preserved across tab switches', () => {
      assert.equal(findInputUnderLabel('Nomor Meja').props.value, 'Meja 7', 'Nomor Meja tetap utuh');
      assert.equal(findInputUnderLabel('Nama Tamu').props.value, 'Andi', 'Nama Tamu tetap utuh');
      const noteNode = h.nodes().find(n => n.type === 'textarea');
      assert.equal(noteNode.props.value, 'Tanpa es', 'Catatan pesanan tetap utuh');
      assert.equal(h.nodes().some(n => n.props['aria-label'] === 'Catatan Coffee'), true, 'Item keranjang tetap utuh');
    });

    h.click('Riwayat Order (1)');
    h.click('POS-55');
    await h.settle();
    check('EDIT existing order loads server metadata (table_number, guest_name, phone, notes)', () => {
      assert.equal(findInputUnderLabel('Meja').props.value, 'VIP-2', 'Meja memuat metadata server');
      assert.equal(findInputUnderLabel('Nama Tamu').props.value, 'Siti Aminah', 'Nama Tamu memuat metadata server');
      assert.equal(findInputUnderLabel('No. WhatsApp').props.value, '08111222333', 'No. WhatsApp memuat metadata server');
      assert.equal(findInputUnderLabel('Catatan Order').props.value, 'Pedas sedang', 'Catatan Order memuat metadata server');
    });
    h.cleanup();

    const hGuest = harness(async (_url, init) => created(JSON.parse(init.body)), {
      reservationId: 42,
      guestNameInitial: 'Tamu Menginap VIP',
      roomNumberInitial: '305',
    });
    await hGuest.settle();
    check('CREATE with guestNameInitial populates Nama Tamu from reservation', () => {
      const guestContainer = hGuest.nodes().find(n => n.type === 'div' && Array.isArray(n.props.children) &&
        n.props.children.some(c => c && c.type === 'label' && String(c.props?.children || '').includes('Nama Tamu')));
      const guestInp = guestContainer.props.children.find(c => c && c.type === 'input');
      assert.equal(guestInp.props.value, 'Tamu Menginap VIP');
    });
    hGuest.cleanup();

    const jsxModal = (type, p, key) => ({ type, props: p || {}, key });
    const modalSlots = [];
    let modalCursor = 0;
    const modalReact = {
      useRef(v) { const i = modalCursor++; if (!modalSlots[i]) modalSlots[i] = { current: v }; return modalSlots[i]; },
      useEffect() {}, useCallback(fn) { return fn; },
    };
    const PosModal = load(compile('PosModal.tsx'), {
      react: modalReact,
      'react/jsx-runtime': { jsx: jsxModal, jsxs: jsxModal },
      './PosWorkspace': { default: () => ({ type: 'div', props: { 'data-workspace': true } }) },
    }).default;
    let refreshed = 0;
    modalCursor = 0;
    const modalTree = PosModal({
      open: true,
      propertyId: 7,
      posMenu: [],
      posOrders: [],
      busy: false,
      payCashModalPresent: false,
      onClose: () => {},
      onRefresh: () => { refreshed++; },
    });
    const modalNodes = [];
    (function walkModal(n) {
      if (Array.isArray(n)) { n.forEach(walkModal); return; }
      if (!n || typeof n !== 'object') return;
      modalNodes.push(n);
      walkModal(n.props?.children);
    })(modalTree);
    check('PosModal header places Refresh Data button to the left of Tutup POS with guard', () => {
      const headerBtns = modalNodes.filter(n => n.type === 'button');
      const refreshIdx = headerBtns.findIndex(b => b.props['aria-label'] === 'Refresh Data');
      const closeIdx = headerBtns.findIndex(b => b.props['aria-label'] === 'Tutup POS');
      assert.ok(refreshIdx >= 0, 'Tombol Refresh Data ada di header PosModal');
      assert.ok(closeIdx > refreshIdx, 'Tombol Refresh Data berada di sebelah kiri tombol Tutup POS');
      assert.ok(typeof headerBtns[refreshIdx].props.title === 'string' && headerBtns[refreshIdx].props.title.length > 0, 'Tooltip Refresh Data tersedia');
      headerBtns[refreshIdx].props.onClick();
      assert.equal(refreshed, 1, 'Klik Refresh Data memanggil onRefresh');
    });
  }
}
(async()=>{if(!contractOnly)await lifecycle();console.log(`\n[RESULT] ${pass} PASS, 0 FAIL${contractOnly?' (contract only; component lifecycle not run)':''}`);})()
 .catch(error=>{console.error('[FAIL]',error);process.exitCode=1;});
