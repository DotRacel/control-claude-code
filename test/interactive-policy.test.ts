/** Regression for Team organization policy on the redirected interactive bridge. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INTERACTIVE_GATES, buildInteractiveLocatorExpr } from '../src/injector/anchors.ts';

const gate = INTERACTIVE_GATES.find((g) => g.id === 'int.policy')!;

// The two measured cache shapes (2.1.229/248 and 2.1.310). Cache access is const to
// model a read-only ES-module import; the breakpoint must change only the result local.
const fixtures = [
  {
    name: 'restrictions map',
    source: 'function $allowed($key){let $policy=readCache();if(!$policy)return false;let entry=$policy[$key];if(entry)return entry.allowed;return true}',
    response: false,
  },
  {
    name: 'policy response',
    source: 'function $allowed($key){let $policy=readCache();if(isClientKey($key)){let entry=$policy?.restrictions[$key];if(entry)return entry.allowed;return false}if(!$policy)return false;return !$denied($key,$policy)}',
    response: true,
  },
];

async function locate(source: string) {
  // Use the production locator, including export resolution and line/column math.
  const context = vm.createContext({ Bun: { main: '/fixture.js', file: () => ({ text: async () => source }) } });
  vm.runInContext(buildInteractiveLocatorExpr('__policy', [gate]), context);
  for (let i = 0; i < 100 && context.__policy === 'pending'; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof context.__policy, 'object');
  const located = context.__policy.gates[0];
  assert.equal(located.error, undefined);
  return located;
}

for (const fixture of fixtures) {
  test(`Team policy: ${fixture.name} allows remote control without changing other policies or cache`, async () => {
    const source = `// exported definition\nvar exports={isPolicyAllowed:()=>$allowed};\n${fixture.source}`;
    const located = await locate(source);
    assert.deepEqual(Array.from(located.names), ['$key', '$policy']);
    assert.equal(located.condition, '$key==="allow_remote_control"', 'other policies do not pause');
    assert.equal(gate.sticky, true, 'each policy check has a new result local');
    const offset = source.split('\n').slice(0, located.line).reduce((n, line) => n + line.length + 1, 0) + located.col;
    assert.equal(source.slice(offset, offset + 3), 'if(', 'pause after the cache result is initialized');
    const rebind = located.names.map((name: string, i: number) => {
      const value = gate.rebindValues[i].replace(/\$\{(\d+)\}/g, (_, n) => located.names[+n]);
      return `${name}=${value};`;
    }).join('');
    const patched = source.slice(0, offset) + rebind + source.slice(offset);
    const restrictions = Object.freeze({
      allow_remote_control: Object.freeze({ allowed: false }),
      allow_remote_sessions: Object.freeze({ allowed: false }),
      allow_web_fetch: Object.freeze({ allowed: false }),
      allow_product_feedback: Object.freeze({ allowed: true }),
    });
    const snapshot = Object.freeze(fixture.response ? { restrictions, compliance_taints: Object.freeze([]) } : restrictions);
    let current: typeof snapshot | null = snapshot;
    const globals = {
      getCache: () => current,
      // Exercise both branches of the newer function's first if.
      isClientKey: (key: string) => key === 'allow_product_feedback',
      $denied: (key: string, policy: any) => {
        const taints = [...policy.compliance_taints];
        return taints.includes('hipaa') || policy.restrictions[key]?.allowed === false;
      },
    };
    const original = vm.createContext(globals);
    vm.runInContext('const readCache=getCache;\n' + source, original);
    assert.equal(vm.runInContext('$allowed("allow_remote_control")', original), false, 'reproduce Team refusal');
    const injected = vm.createContext({ ...globals });
    vm.runInContext('const readCache=getCache;\n' + patched, injected);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(vm.runInContext('$allowed("allow_remote_control")', injected), true);
      assert.equal(vm.runInContext('$allowed("allow_web_fetch")', injected), false);
      assert.equal(vm.runInContext('$allowed("allow_remote_sessions")', injected), false);
      assert.equal(vm.runInContext('$allowed("allow_product_feedback")', injected), true);
      assert.equal(current, snapshot);
      assert.equal(restrictions.allow_remote_control.allowed, false);
    }
    current = null;
    assert.equal(vm.runInContext('$allowed("allow_remote_control")', injected), true, 'also handles an unloaded policy cache');
    assert.equal(vm.runInContext('$allowed("allow_web_fetch")', injected), false);
  });
}
