// Mark the jsdom test run as an act-compatible React environment so state
// updates wrapped in act() are recognised (suppresses the environment
// warning without changing any test behaviour).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
