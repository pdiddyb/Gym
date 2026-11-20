// Weight units: lb and kg. Plain functions with no screen or account state, so the tests in
// /tests can load them in Node.
//
// Every set is stored exactly as it was entered: { weight, unit }. Sets saved before units
// existed have no unit and are kilograms. Converting only ever happens on the way to the
// screen; stored values are never rewritten.

export const UNITS = ['lb', 'kg'];
export const KG_PER_LB = 0.45359237;

export const unitOf = (set) => (set.unit === 'lb' ? 'lb' : 'kg');

export function convertWeight(weight, from, to) {
  if (from === to) {
    return weight;
  }
  return from === 'lb' ? weight * KG_PER_LB : weight / KG_PER_LB;
}

// One decimal place, without a trailing ".0".
export const roundForDisplay = (weight) => String(Math.round(weight * 10) / 10);

// ---------- Weight fields ----------
//
// A weight field that the unit can be switched under (the add-set row) keeps its value as a
// source: { text, unit }, the text as typed, or as pre-filled from a stored set, and the unit
// it was in. What the field shows is always worked out from the source, never from what it
// showed before, so switching units back and forth can't make the number drift (converting
// the shown 2.3 kg back would give 5.1 lb, not the 5 lb it came from).

// The source for a field pre-filled with a stored set's weight, exactly as stored.
export const sourceFromSet = (set) => ({ text: String(set.weight), unit: unitOf(set) });

// The text the field shows in `unit`: the source text itself in its own unit (or when it isn't
// a number above 0), otherwise the source converted and rounded to one decimal place.
export function weightFieldText(source, unit) {
  const value = Number(source.text);
  if (source.unit === unit || source.text.trim() === '' || !(value > 0)) {
    return source.text;
  }
  return roundForDisplay(convertWeight(value, source.unit, unit));
}

// { weight, unit } to store for the source: the number in the unit it was typed in. An empty
// field is bodyweight, 0.
export function weightToStore(source) {
  const value = Number(source.text);
  return { weight: value > 0 ? value : 0, unit: source.unit };
}
