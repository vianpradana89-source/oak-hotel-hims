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
check('Explicit zero-valued discount still requires the separate permission', () => {
  assert.throws(() => D.buildPosOrderDraft(plain,{...details,discountType:'NOMINAL',discountInput:'0'},false));
  assert.throws(() => D.buildPosOrderDraft(lines,details,false));
});
for (const [type,input] of [['NOMINAL','1.5'],['NOMINAL','-1'],['NOMINAL','1e3'],['NOMINAL',''],['PERCENT','100.01'],['PERCENT','1.001'],['PERCENT','NaN'],['PERCENT','']])
  check('Reject invalid '+type+' discount '+JSON.stringify(input), () => assert.throws(() => D.previewPosDraft(plain,type,input)));
check('Reject nominal above LINE or post-LINE order basis', () => {
  assert.throws(() => D.previewPosDraft([{...plain[0],discountType:'NOMINAL',discountInput:'13001'}],'',''));
  assert.throws(() => D.previewPosDraft(lines,'NOMINAL','61001'));
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
  const component = load(compile('PosWorkspace.tsx'), {react, 'react/jsx-runtime': {jsx, jsxs: jsx}, './posOrderDraft': D, './GuestPicker': {default: () => null}}).default;
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
  function byAria(name,value) {const n=nodes().find(n=>n.props['aria-label']===name && (n.type==='input'||n.type==='select'));
    assert.ok(n,'Missing input '+name);assert.equal(!!n.props.disabled,false);n.props.onChange({target:{value}});render();}
  function labelled(name,value) {const l=nodes().find(n=>n.type==='label'&&label(n).includes(name));assert.ok(l,'Missing label '+name);
    const children=Array.isArray(l.props.children)?l.props.children:[l.props.children];const n=children.find(n=>n&&typeof n==='object'&&['input','textarea','select'].includes(n.type));
    assert.ok(n);assert.equal(!!n.props.disabled,false);n.props.onChange({target:{value}});render();}
  function addItem() {const n=nodes().find(n=>n.type==='div'&&typeof n.props.onClick==='function'&&label(n).includes('Coffee'));assert.ok(n,'Missing menu Coffee');assert.equal(!!n.props.disabled,false);n.props.onClick();render();}
  async function settle() {await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render();}
  render(); return {render,nodes,button,click,byAria,labelled,addItem,settle,signals,
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
  h.click('Bayar');await h.settle();
  check('Workspace ordinary Bayar sends snapshots with no discounts/prices; payment uses server amount',()=>{
    assert.equal(requests.length,1);const b=requests[0].body;assert.equal(b.guest_phone,'+628123456789');assert.equal(b.notes,'Order note');assert.equal(b.items[0].notes,'hot');
    assert.equal('unit_price' in b.items[0],false);assert.equal('discount_type' in b,false);
    assert.equal(h.signals.created.length,1);assert.equal(h.signals.pay.length,1);assert.equal(h.signals.pay[0].totalAmount,'10000');
    assert.equal(h.nodes().some(n=>n.props['aria-label']==='Diskon item Coffee'),false);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(JSON.parse(init.body));return created(requests.at(-1));});h.addItem();
  h.byAria('Diskon item Coffee','NOMINAL');h.byAria('Nilai diskon Coffee','1000');h.labelled('Diskon pesanan','PERCENT');
  h.byAria('Nilai diskon pesanan','10');h.byAria('Alasan diskon pesanan','member');h.click('Simpan Pesanan');await h.settle();
  check('Workspace granted discount emits LINE then order fields; save alone never opens pay',()=>{
    assert.equal(requests[0].items[0].discount_type,'NOMINAL');assert.equal(requests[0].items[0].discount_value,1000);
    assert.equal(requests[0].discount_type,'PERCENT');assert.equal(requests[0].discount_value,10);assert.equal(requests[0].discount_reason,'member');
    assert.equal(h.signals.created.length,1);assert.equal(h.signals.pay.length,0);
  });h.cleanup();
  requests=[];let attempt=0;
  h=harness(async(_url,init)=>{requests.push({body:init.body,key:init.headers['Idempotency-Key']});
    if(++attempt===1)throw new Error('network');if(attempt===2)return json({code:'DISCOUNT_PERMISSION_DENIED'},403);return created(JSON.parse(init.body),200);});
  h.addItem();h.byAria('Diskon item Coffee','NOMINAL');h.byAria('Nilai diskon Coffee','1000');h.labelled('Nomor WhatsApp','+628123');
  h.labelled('Catatan pesanan','same order');h.click('Simpan Pesanan');await h.settle();
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
    requests=[];h=harness(async(_url,init)=>{requests.push(init.body);throw new Error('network');});h.addItem();h.click('Simpan Pesanan');await h.settle();
    h.changeProps(scope==='property'?{propertyId:8}:{reservationId:99});h.click('Coba Lagi');await h.settle();
    check('Workspace '+scope+' change cannot retarget unresolved create',()=>{
      assert.equal(requests.length,1);assert.equal(h.signals.unresolved.at(-1),true);assert.equal(h.signals.created.length,0);
    });h.cleanup();
  }
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});h.addItem();
  h.byAria('Diskon item Coffee','PERCENT');h.byAria('Nilai diskon Coffee','100');
  check('Workspace zero-total Bayar disabled; ordinary save still separate',()=>{
    assert.equal(h.button('Bayar').props.disabled,true);assert.equal(h.button('Simpan Pesanan').props.disabled,false);assert.equal(requests.length,0);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return json({status:'SUCCESS',data:{id:9,property_id:8,order_number:'FOREIGN',status:'OPEN',total_amount:'13000'}},201);});
  h.addItem();h.click('Bayar');await h.settle();
  check('Workspace malformed scope in success stays unresolved and does not open payment',()=>{
    assert.equal(h.signals.created.length,0);assert.equal(h.signals.pay.length,0);assert.equal(h.signals.unresolved.at(-1),true);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});h.addItem();
  h.labelled('Nomor WhatsApp','x'.repeat(51));h.click('Simpan Pesanan');await h.settle();
  check('Workspace invalid input fails before pending/POST; draft remains editable',()=>{
    assert.equal(requests.length,0);assert.equal(h.signals.pending.includes(true),false);
    assert.equal(h.nodes().find(n=>n.type==='textarea').props.disabled,false);
  });h.cleanup();
  requests=[];h=harness(async(_url,init)=>{requests.push(init.body);return created(JSON.parse(init.body));});h.addItem();
  h.byAria('Diskon item Coffee','NOMINAL');h.byAria('Nilai diskon Coffee','1000');h.changeProps({canDiscountPos:false});
  check('Workspace permission lost retains draft and offers explicit removal',()=>assert.equal(h.button('Simpan Pesanan').props.disabled,true));
  h.click('Hapus semua diskon');h.click('Simpan Pesanan');await h.settle();
  check('Workspace explicit removal preserves items and sends ordinary order',()=>{
    assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0]).items.length,1);assert.equal('discount_type' in JSON.parse(requests[0]).items[0],false);
  });h.cleanup();
}
(async()=>{if(!contractOnly)await lifecycle();console.log(`\n[RESULT] ${pass} PASS, 0 FAIL${contractOnly?' (contract only; component lifecycle not run)':''}`);})()
 .catch(error=>{console.error('[FAIL]',error);process.exitCode=1;});
