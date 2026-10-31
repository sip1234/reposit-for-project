// 仿真 profile 与 API 参数校验的最小离线测试（不需要数据库或 Docker）。
const assert = require('node:assert/strict');
const profile = require('../shared/plant_profile.json');
const simulation = require('../server/simulation');
const optimization = require('../server/optimization');

function inside(value, range) {
  return value >= range.min && value <= range.max;
}

assert.equal(profile.profileId, 'bsm1-default');
assert.equal(profile.model, 'BSM1');
assert.match(profile.modelImplementation, /^bsm2-python==/);

for (const name of ['doSetpoint', 'recycleRatio', 'carbonDose']) {
  const hard = profile.hardRanges[name];
  const search = profile.searchRanges[name];
  assert.ok(hard.min < hard.max, `${name} hard range must be ordered`);
  assert.ok(inside(hard.default, hard), `${name} default must be inside hard range`);
  assert.ok(search.min >= hard.min && search.max <= hard.max, `${name} search range must be inside hard range`);
  assert.ok(search.min < search.max, `${name} search range must be ordered`);
}

assert.equal(profile.constraints.kla5.min, 0);
assert.equal(profile.constraints.kla5.max, 240, 'KLa5 must follow the BSM1 specification (0-10 h-1)');
assert.ok(profile.constraints.doTank5Min > 0);
for (const key of ['snh', 'ntot', 'tss', 'cod', 'bod5']) {
  assert.ok(profile.constraints.effluent[key] > 0, `effluent.${key} must be positive`);
}

assert.ok(profile.evaluation.horizonDays > 0 && profile.evaluation.horizonDays <= 14);
assert.ok(profile.evaluation.evalDays >= 1 && profile.evaluation.evalDays <= profile.evaluation.horizonDays);
assert.equal(profile.evaluation.stepMinutes, 1);
assert.equal(profile.evaluation.stabilize, true, 'stabilization must be on by default');
assert.ok(profile.evaluation.stabilizeAtol > 0);
assert.equal(profile.evaluation.loadFactor, 1.0);
assert.deepEqual(profile.loadScenarios, { low: 0.7, normal: 1.0, high: 1.3 });
assert.ok(['dry', 'rain'].includes(profile.evaluation.influent));

const defaults = simulation.validParams({});
assert.equal(defaults.error, undefined);
assert.equal(defaults.params.doSetpoint, profile.hardRanges.doSetpoint.default);
assert.equal(defaults.params.recycleRatio, profile.hardRanges.recycleRatio.default);
assert.equal(defaults.params.carbonDose, profile.hardRanges.carbonDose.default);
assert.equal(defaults.params.profileId, profile.profileId);
assert.equal(defaults.params.stabilize, true);
assert.equal(defaults.params.loadFactor, 1.0);

assert.ok(simulation.validParams({ doSetpoint: 0.4 }).error, 'DO below hard min must be rejected');
assert.ok(simulation.validParams({ doSetpoint: 4.1 }).error, 'DO above hard max must be rejected');
assert.ok(simulation.validParams({ recycleRatio: -0.1 }).error, 'negative recycle must be rejected');
assert.ok(simulation.validParams({ carbonDose: 5.1 }).error, 'carbon above hard max must be rejected');
assert.ok(simulation.validParams({ plantProfileId: 'other-plant' }).error, 'unknown profile must be rejected');
assert.ok(simulation.validParams({ stabilize: 'yes' }).error, 'non-boolean stabilize must be rejected');
assert.ok(simulation.validParams({ loadFactor: 0.4 }).error, 'load below 0.5 must be rejected');
assert.ok(simulation.validParams({ loadFactor: 2.1 }).error, 'load above 2.0 must be rejected');
assert.equal(simulation.validParams({ loadFactor: 1.3 }).params.loadFactor, 1.3);

const edge = simulation.validParams({ doSetpoint: 1.5, recycleRatio: 2, carbonDose: 0 });
assert.equal(edge.error, undefined);
assert.equal(edge.params.doSetpoint, 1.5);
assert.equal(edge.params.recycleRatio, 2);
assert.equal(edge.params.carbonDose, 0);

const opt = optimization.validParams({ evaluations: 4, initial: 4 });
assert.equal(opt.error, undefined);
assert.equal(opt.params.evaluations, 4);
assert.equal(opt.params.initial, 4);
assert.equal(opt.params.no_stabilize, false);
assert.ok(optimization.validParams({ evaluations: 3 }).error, 'optimization below 4 evaluations must be rejected');
assert.ok(optimization.validParams({ evaluations: 4, initial: 5 }).error, 'initial above evaluations must be rejected');
assert.ok(optimization.validParams({ loadFactor: 2.1 }).error, 'optimization load above 2.0 must be rejected');

console.log(JSON.stringify({
  result: 'PASS',
  profile: profile.profileId,
  kla5Max: profile.constraints.kla5.max,
  checks: [
    'profile identity', 'hard/search range ordering', 'defaults inside ranges',
    'KLa5 specification limit', 'effluent limits', 'evaluation window',
    'API defaults', 'API hard-limit rejection', 'unknown profile rejection'
  ]
}, null, 2));
