/** Error checks complement Prettier; visual conventions belong to shared styles. */
export default {
  extends: ['stylelint-config-recommended'],
  rules: {
    // Independent component subtrees legitimately use different specificity.
    'no-descending-specificity': null,
  },
};
