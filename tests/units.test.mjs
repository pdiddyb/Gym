// Weight fields that the lb/kg unit can be switched under (the add-set row). Run with
// `node --test tests/` (Node 22.12 or later, no packages needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertWeight, roundForDisplay, sourceFromSet, weightFieldText, weightToStore } from '../UI/units.js';

const VALUES = [5, 45, 135, 2.5];

// What the row's weight field does on each lb/kg switch: show the source in the new unit.
// `switches` is the units shown in turn.
function shownOnSwitches(source, switches) {
  return switches.map((unit) => ({ unit, text: weightFieldText(source, unit) }));
}

// lb -> kg -> lb -> kg -> lb ..., ten round trips.
const TEN_ROUND_TRIPS = Array.from({ length: 10 }, () => ['kg', 'lb']).flat();

for (const weight of VALUES) {
  test(`${weight} lb pre-filled: ten lb/kg round trips never change the value`, () => {
    const source = sourceFromSet({ weight, unit: 'lb', reps: 5 });
    assert.equal(weightFieldText(source, 'lb'), String(weight));
    const kg = weightFieldText(source, 'kg');
    for (const { unit, text } of shownOnSwitches(source, TEN_ROUND_TRIPS)) {
      assert.equal(text, unit === 'lb' ? String(weight) : kg, `${unit} showed ${text}`);
    }
    // Added without editing, in either unit: stored exactly as the previous set was.
    assert.deepEqual(weightToStore(source), { weight, unit: 'lb' });
  });

  test(`${weight} kg pre-filled: ten kg/lb round trips never change the value`, () => {
    const source = sourceFromSet({ weight, unit: 'kg', reps: 5 });
    const lb = weightFieldText(source, 'lb');
    for (const { unit, text } of shownOnSwitches(source, TEN_ROUND_TRIPS)) {
      assert.equal(text, unit === 'kg' ? String(weight) : lb, `${unit} showed ${text}`);
    }
    assert.deepEqual(weightToStore(source), { weight, unit: 'kg' });
  });
}

test('the values above do lose precision when converted from the shown text', () => {
  // Guards the test itself: converting from the rounded text, as the row used to, drifts.
  const viaShownText = (weight) => roundForDisplay(convertWeight(Number(roundForDisplay(convertWeight(weight, 'lb', 'kg'))), 'kg', 'lb'));
  assert.equal(viaShownText(5), '5.1');
  assert.ok(VALUES.some((weight) => viaShownText(weight) !== String(weight)));
});

test('a number typed after switching becomes the source, in the unit it was typed in', () => {
  // Pre-filled 5 lb, switched to kg (shows 2.3), then 2.5 typed.
  const typed = { text: '2.5', unit: 'kg' };
  for (const { unit, text } of shownOnSwitches(typed, TEN_ROUND_TRIPS)) {
    assert.equal(text, unit === 'kg' ? '2.5' : '5.5');
  }
  assert.deepEqual(weightToStore(typed), { weight: 2.5, unit: 'kg' });
});

test('text that is not a weight above 0 is shown as it is in either unit', () => {
  for (const text of ['', '0', '62.']) {
    assert.equal(weightFieldText({ text, unit: 'lb' }, 'lb'), text);
  }
  assert.equal(weightFieldText({ text: '', unit: 'lb' }, 'kg'), '');
  assert.equal(weightFieldText({ text: '0', unit: 'lb' }, 'kg'), '0');
  // A trailing point mid-typing still converts, and comes back exactly.
  assert.equal(weightFieldText({ text: '62.', unit: 'kg' }, 'lb'), '136.7');
  assert.deepEqual(weightToStore({ text: '', unit: 'kg' }), { weight: 0, unit: 'kg' });
});
