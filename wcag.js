const CRITERIA = Object.freeze({
  '1.1.1': 'Non-text Content', '1.3.1': 'Info and Relationships', '1.4.3': 'Contrast (Minimum)',
  '1.4.4': 'Resize Text', '2.1.1': 'Keyboard', '2.4.2': 'Page Titled', '2.4.4': 'Link Purpose',
  '3.1.1': 'Language of Page', '3.3.2': 'Labels or Instructions', '4.1.1': 'Parsing',
  '4.1.2': 'Name, Role, Value',
});

const BY_RULE = Object.freeze({
  'aria-allowed-attr': '4.1.2', 'aria-hidden-body': '4.1.2', 'aria-prohibited-attr': '4.1.2',
  'aria-required-attr': '4.1.2', 'aria-valid-attr-value': '4.1.2', 'button-name': '4.1.2',
  'color-contrast': '1.4.3', 'document-title': '2.4.2', 'duplicate-id-aria': '4.1.1',
  'heading-order': '1.3.1', 'html-has-lang': '3.1.1', 'image-alt': '1.1.1',
  'image-redundant-alt': '1.1.1', label: '3.3.2', 'landmark-main-is-top-level': '1.3.1',
  'landmark-no-duplicate-main': '1.3.1', 'landmark-one-main': '1.3.1', 'link-name': '2.4.4',
  'meta-viewport': '1.4.4', region: '1.3.1', 'select-name': '4.1.2',
});

function criterionId(violation) {
  const tag = (violation.tags || []).find(value => /^wcag\d{3,4}$/i.test(value));
  if (tag) {
    const digits = tag.replace(/\D/g, '');
    return digits.length === 3 ? `${digits[0]}.${digits[1]}.${digits[2]}` : `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
  }
  return BY_RULE[violation.id] || 'Review required';
}

function criterionDescription(id) {
  return CRITERIA[id] || 'Manual WCAG review required';
}

module.exports = { criterionDescription, criterionId };
