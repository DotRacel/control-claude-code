/** QR placement across the 2.1.317 message/renderer change. Uses the shipped locator and payload. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInteractiveLocatorExpr, type InteractiveGateSpec } from '../src/injector/anchors.ts';
import { selectProfile } from '../src/injector/profiles.ts';
import { renderQrAscii } from '../src/injector/qr.ts';

const origin = 'https://ccc.racel.dev';
const url = origin + '/code/session_5927e50246ee2379';

// Measured .317/.318 renderer, with $ names to exercise minified aliases. The compiler cache
// and hooks are stubbed, while the returned element tree and cache branches are the real shape.
const rendererFixture = 'function $render(m){let g=S(8),{message:$d,addMargin:c}=m,f;if(g[0]!==$d)f=(h)=>h.replBridgeConnected&&!h.replBridgeOutboundOnly&&h.replBridgeSessionUrl===$d.url,g[0]=$d,g[1]=f;else f=g[1];if(!z(f)){return null}const b=c?1:0;let E;if(g[2]===w)E=e(s,{minWidth:2}),g[2]=E;else E=g[2];let k;if(g[3]!==$d.url)k=e(s,{flexDirection:"column",children:r(n,{children:["/remote-control is active",r(n,{dimColor:!0,children:[" · Continue here, on your phone, or at ",e(rn,{url:$d.url,children:$d.url})]})]})}),g[3]=$d.url,g[4]=k;else k=g[4];let $I;if(g[5]!==b||g[6]!==k)$I=r(s,{flexDirection:"row",marginTop:b,width:999,children:[E,k]}),g[5]=b,g[6]=k,g[7]=$I;else $I=g[7];return $I}';

async function patch(source: string, gate: InteractiveGateSpec) {
  const context = vm.createContext({ Bun: { main: '/fixture.js', file: () => ({ text: async () => source }) } });
  vm.runInContext(buildInteractiveLocatorExpr('__qr', [gate]), context);
  for (let i = 0; i < 100 && context.__qr === 'pending'; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  const located = context.__qr.gates[0];
  assert.equal(located.error, undefined);
  const offset = source.split('\n').slice(0, located.line).reduce((n, line) => n + line.length + 1, 0) + located.col;
  const rebind = located.names.map((name: string, i: number) => {
    const value = gate.rebindValues[i].replace(/\$\{(\d+|URL)\}/g, (_, n) => n === 'URL' ? JSON.stringify(origin) : located.names[+n]);
    return `${name}=${value};`;
  }).join('');
  return { source: source.slice(0, offset) + rebind + source.slice(offset), located, offset };
}

test('renderer QR: first frame, cached renders and reconnect retain the original link and cache', async () => {
  const gate = selectProfile('2.1.317').profile.interactiveGates.find((g) => g.id === 'int.qrnudge')!;
  const patched = await patch(rendererFixture, gate);
  assert.equal(rendererFixture.slice(patched.offset, patched.offset + 9), 'return $I');
  assert.equal(gate.sticky, true);
  const sentinel = Symbol('memo');
  const cache = Array(8).fill(sentinel);
  let currentUrl = url;
  let width = 80;
  let connected = true;
  const jsx = (type: string, props: any) => Object.freeze({ $$typeof: Symbol.for('react.transitional.element'), type, key: null, props: Object.freeze(props) });
  const context = vm.createContext({
    S: () => cache, w: sentinel,
    z: (read: any) => read({ replBridgeConnected: connected, replBridgeSessionUrl: currentUrl }),
    jsx, __cccQr: renderQrAscii,
    process: { stdout: { get columns() { return width; } } },
  });
  // JSX functions and component types model read-only imports. The injection only writes locals.
  vm.runInContext('const e=jsx,r=jsx,s="Box",n="Text",rn="Link";\n' + patched.source, context);
  const draw = () => vm.runInContext(`$render({message:{url:${JSON.stringify(currentUrl)}},addMargin:true})`, context);
  for (let i = 0; i < 3; i++) {
    const root = draw();
    const column = root.props.children[1];
    assert.equal(column.props.children.length, 2);
    const [original, qr] = column.props.children;
    assert.equal(original.props.children[1].props.children[1].props.url, currentUrl);
    assert.equal(qr.props.children, renderQrAscii(currentUrl, { origin, maxWidth: width - 6 }));
    assert.equal(qr.type, 'Text');
    assert.equal(root.$$typeof, Symbol.for('react.transitional.element'));
    assert.equal(root.props.marginTop, 1);
    assert.equal(Array.isArray(cache[7].props.children[1].props.children), false, 'cache retains the unmodified Text element');
    if (i === 1) currentUrl = origin + '/code/session_reconnected';
  }
  width = 20;
  assert.equal(draw(), cache[7], 'narrow terminals retain the original element');
  width = 80;
  currentUrl = 'https://claude.ai/code/session_foreign';
  assert.equal(draw(), cache[7], 'foreign links get no QR');
  context.__cccQr = undefined;
  assert.equal(draw(), cache[7], 'missing encoder is harmless');
  connected = false;
  assert.equal(draw(), null, 'inactive bridge stays hidden');
});

test('legacy QR: factory parameter injection preserves the message URL and a real upgrade nudge', async () => {
  const gate = selectProfile('2.1.316').profile.interactiveGates.find((g) => g.id === 'int.qrnudge')!;
  const source = 'function $factory($u,$n){return{type:"system",subtype:"bridge_status",content:`/remote-control is active · Continue here, on your phone, or at ${$u}`,url:$u,upgradeNudge:$n,isMeta:!1,timestamp:"now",uuid:"fixture"}}';
  const patched = await patch(source, gate);
  const context = vm.createContext({ __cccQr: renderQrAscii });
  vm.runInContext(patched.source, context);
  const message = vm.runInContext(`$factory(${JSON.stringify(url)})`, context);
  assert.equal(message.url, url);
  assert.equal(message.upgradeNudge, renderQrAscii(url, { origin, maxWidth: 74 }));
  assert.equal(vm.runInContext(`$factory(${JSON.stringify(url)},"upgrade")`, context).upgradeNudge, 'upgrade');
});

test('URL override: follow first, last and singleton import aliases and rebind before the first call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-url-module-'));
  const main = path.join(dir, 'main.js');
  const target = path.join(dir, 'target.js');
  const targetSource = '// @bun @bytecode\nimport"node:fs";\nvar first=$override();function $override(){return}export{$override as actual}';
  fs.writeFileSync(target, targetSource);
  const gate = selectProfile('2.1.318').profile.interactiveGates.find((g) => g.id === 'int.baseurl')!;
  try {
    for (const clause of ['actual as $url', 'actual as $url,other', 'other,actual as $url', '$override', '$override,other', 'other,$override']) {
      const local = clause.includes(' as ') ? '$url' : '$override';
      const definition = clause.includes(' as ') ? targetSource : targetSource.replace('$override as actual', '$override');
      fs.writeFileSync(target, definition);
      const source = `import{${clause}}from${JSON.stringify(target)};export{${local} as getBridgeBaseUrlOverride}`;
      const context = vm.createContext({ Bun: { main, file: () => ({ text: async () => source }) } });
      vm.runInContext(buildInteractiveLocatorExpr('__url', [gate]), context, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      for (let i = 0; i < 100 && context.__url === 'pending'; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      const located = context.__url.gates[0];
      assert.equal(located.error, undefined, clause);
      assert.equal(located.file, target);
      assert.deepEqual(Array.from(located.names), ['$override']);
      assert.equal(located.line, 2, 'skip bytecode header and static imports');
      assert.equal(located.col, 0, 'pause at first executable statement');
      const injected = '$override=' + gate.rebindValues[0].replace('${URL}', JSON.stringify(origin)) + ';';
      const runtime = vm.createContext({});
      vm.runInContext(injected + definition.slice(definition.indexOf('var first=')).replace(/export\{[^}]*\}/, ''), runtime);
      assert.equal(runtime.first, origin, 'first consumer already sees the backend URL');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
