// Unit tests for config-io.js — pure import/export logic of the widget config.
// config-io.js is a plain browser script attaching window.IntraFormConfigIO;
// it is evaluated once here (happy-dom provides `window`) and the sanitizer is
// injected, so no DOMPurify/Grist/Vue are needed.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'config-io.js'), 'utf-8');

let IO;

beforeAll(() => {
  new Function(src)();
  IO = window.IntraFormConfigIO;
});

// Identity sanitizer (passthrough)
const identitySanitize = (s) => s;

// Fake sanitizer mimicking DOMPurify: strips tags entirely
const stripSanitize = (s) => String(s).replace(/<[^>]*>/g, '');

// Column metadata fixture (subset of what getColumnMetadata() returns)
const meta = {
  Nom: { type: 'Text', label: 'Nom', isRef: false, isMultiple: false, isBool: false, isDate: false, isDateTime: false, isNumeric: false, isInt: false, isAttachment: false, isFormula: false, choices: null, refChoices: [] },
  Statut: { type: 'Choice', label: 'Statut', choices: ['Actif', 'Inactif'], isRef: false, isMultiple: false },
  Tags: { type: 'ChoiceList', label: 'Tags', choices: ['a', 'b'], isMultiple: true },
  Client: { type: 'Ref:Clients', label: 'Client', isRef: true, isMultiple: false, refChoices: [{ id: 1, label: 'A' }] },
  Date: { type: 'Date', label: 'Date', isDate: true },
  Quantite: { type: 'Int', label: 'Quantité', isInt: true }
};

const tables = ['Form', 'Clients'];

describe('buildConfigPayload', () => {
  it('wraps the config in a versioned envelope', () => {
    const payload = IO.buildConfigPayload(
      { formElements: [{ type: 'separator', content: '' }], globalFont: 'Arial', globalPadding: 'small' },
      meta
    );
    expect(payload.widget).toBe('grist-cw-intra-form');
    expect(payload.version).toBe(1);
    expect(payload.config.globalFont).toBe('Arial');
    expect(payload.config.globalPadding).toBe('small');
    expect(payload.config.formElements).toEqual([{ type: 'separator', content: '' }]);
  });

  it('enriches field elements with column metadata', () => {
    const el = { type: 'field', fieldName: 'Statut', fieldLabel: 'Statut', required: true };
    const payload = IO.buildConfigPayload({ formElements: [el] }, meta);
    const exported = payload.config.formElements[0];
    expect(exported.columnType).toBe('Choice');
    expect(exported.columnChoices).toEqual(['Actif', 'Inactif']);
    expect(exported.columnLabel).toBe('Statut');
  });

  it('deep-copies elements (mutations do not leak into the source)', () => {
    const el = { type: 'field', fieldName: 'Nom' };
    const payload = IO.buildConfigPayload({ formElements: [el] }, meta);
    payload.config.formElements[0].required = true;
    expect(el.required).toBeUndefined();
  });

  it('handles missing column metadata gracefully', () => {
    const payload = IO.buildConfigPayload({ formElements: [{ type: 'field', fieldName: 'Ghost' }] }, meta);
    expect(payload.config.formElements[0].columnType).toBeNull();
    expect(payload.config.formElements[0].columnLabel).toBe('Ghost');
  });
});

describe('normalizeImportedConfig — shape validation', () => {
  const envelope = (config) => ({ widget: 'grist-cw-intra-form', version: 1, config });

  it('accepts the export envelope', () => {
    const r = IO.normalizeImportedConfig(envelope({ formElements: [] }), {
      columnMetadata: meta, sanitize: identitySanitize
    });
    expect(r.ok).toBe(true);
    expect(r.missingColumns).toEqual([]);
  });

  it('accepts a bare config object (e.g. raw widget options)', () => {
    const r = IO.normalizeImportedConfig({ formElements: [], globalFont: 'Arial' }, {
      columnMetadata: meta, sanitize: identitySanitize
    });
    expect(r.ok).toBe(true);
    expect(r.config.globalFont).toBe('Arial');
  });

  it('rejects payloads without a formElements list', () => {
    expect(IO.normalizeImportedConfig({}, { columnMetadata: meta, sanitize: identitySanitize }).ok).toBe(false);
    expect(IO.normalizeImportedConfig(null, { columnMetadata: meta, sanitize: identitySanitize }).ok).toBe(false);
    expect(IO.normalizeImportedConfig({ config: { formElements: 'nope' } }, { columnMetadata: meta, sanitize: identitySanitize }).ok).toBe(false);
  });

  it('rejects a foreign widget name', () => {
    const r = IO.normalizeImportedConfig({ widget: 'other-widget', version: 1, config: { formElements: [] } }, {
      columnMetadata: meta, sanitize: identitySanitize
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('other-widget');
  });

  it('rejects a future version', () => {
    const r = IO.normalizeImportedConfig({ widget: 'grist-cw-intra-form', version: 99, config: { formElements: [] } }, {
      columnMetadata: meta, sanitize: identitySanitize
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('99');
  });
});

describe('normalizeImportedConfig — elements', () => {
  it('sanitizes HTML content of text and field elements', () => {
    const payload = {
      formElements: [
        { type: 'text', content: 'hello <script>alert(1)</script><b>bold</b>' },
        { type: 'field', fieldName: 'Nom', fieldLabel: '<img src=x onerror=alert(1)>Nom' }
      ]
    };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: stripSanitize });
    // The fake sanitizer strips tags but keeps inner text (DOMPurify drops
    // <script> content entirely — the important part is no tag survives)
    expect(r.config.formElements[0].content).toBe('hello alert(1)bold');
    expect(r.config.formElements[1].fieldLabel).toBe('Nom');
  });

  it('normalizes field properties (maxLength, required, multiline)', () => {
    const payload = {
      formElements: [
        { type: 'field', fieldName: 'Nom', required: 'yes', maxLength: '50', multiline: true },
        { type: 'field', fieldName: 'Date', required: true, maxLength: 12, multiline: true },
        { type: 'field', fieldName: 'Nom', maxLength: 'not-a-number' }
      ]
    };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: identitySanitize });
    const [nom1, date, nom2] = r.config.formElements;
    expect(nom1.required).toBe(true);
    expect(nom1.maxLength).toBe(50);
    expect(nom1.multiline).toBe(true);
    // maxLength/multiline are invalid on a Date column: cleaned up
    expect(date.maxLength).toBeUndefined();
    expect(date.multiline).toBeUndefined();
    expect(nom2.maxLength).toBeNull();
  });

  it('keeps a valid conditional rule and drops invalid ones', () => {
    const payload = {
      formElements: [
        { type: 'field', fieldName: 'Nom', conditional: { field: 'Statut', operator: 'equals', value: 'Actif' } },
        { type: 'field', fieldName: 'Nom', conditional: { field: 'Statut', operator: 'contains', value: 'x' } },
        { type: 'field', fieldName: 'Nom', conditional: { field: 'Ghost', operator: 'equals', value: 'x' } },
        { type: 'field', fieldName: 'Nom', conditional: { field: 'Nom', operator: 'equals', value: 'x' } }
      ]
    };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: identitySanitize });
    expect(r.config.formElements[0].conditional).toEqual({ field: 'Statut', operator: 'equals', value: 'Actif' });
    // invalid rules are dropped (null when never set, undefined when deleted by cleanup)
    expect(r.config.formElements[1].conditional).toBeFalsy();
    expect(r.config.formElements[2].conditional).toBeFalsy();
    // condition on a plain Text column is not a valid condition field
    expect(r.config.formElements[3].conditional).toBeFalsy();
  });

  it('reports missing columns and preserves recreation info', () => {
    const payload = {
      formElements: [
        { type: 'field', fieldName: 'Absent', required: true, columnType: 'Choice', columnChoices: ['X', 'Y'], columnLabel: 'Absent' },
        { type: 'field', fieldName: 'Nom' }
      ]
    };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: identitySanitize });
    expect(r.ok).toBe(true);
    expect(r.missingColumns).toEqual(['Absent']);
    const absent = r.config.formElements[0];
    expect(absent.type).toBe('field');
    expect(absent.columnType).toBe('Choice');
    expect(absent.columnChoices).toEqual(['X', 'Y']);
    expect(absent.required).toBe(true);
  });

  it('does not report known columns as missing', () => {
    const payload = { formElements: [{ type: 'field', fieldName: 'Statut' }] };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: identitySanitize });
    expect(r.missingColumns).toEqual([]);
    expect(r.config.formElements[0].columnType).toBeUndefined();
  });

  it('whitelists globalPadding and strips invalid font characters', () => {
    const payload = { formElements: [], globalPadding: 'huge', globalFont: 'Ari;al{}<b>, sans-serif' };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: identitySanitize });
    expect(r.config.globalPadding).toBe('');
    // invalid characters are stripped, remaining letters kept
    expect(r.config.globalFont).toBe('Arialb, sans-serif');
  });

  it('drops malformed and unknown elements', () => {
    const payload = {
      formElements: [
        null,
        'string',
        { type: 'unknown' },
        { type: 'field' },
        { type: 'separator' },
        { type: 'text', content: 'ok' }
      ]
    };
    const r = IO.normalizeImportedConfig(payload, { columnMetadata: meta, sanitize: identitySanitize });
    expect(r.config.formElements).toEqual([
      { type: 'separator', content: '' },
      { type: 'text', content: 'ok' }
    ]);
  });
});

describe('cleanupElement', () => {
  it('removes multiline on non-pure-text fields', () => {
    const el = { type: 'field', fieldName: 'Quantite', multiline: true };
    IO.cleanupElement(el, meta);
    expect(el.multiline).toBeUndefined();
  });

  it('removes maxLength on non-text fields', () => {
    const el = { type: 'field', fieldName: 'Date', maxLength: 10 };
    IO.cleanupElement(el, meta);
    expect(el.maxLength).toBeUndefined();
  });

  it('removes a conditional rule referencing an invalid condition field', () => {
    const el = { type: 'field', fieldName: 'Nom', conditional: { field: 'Nom', operator: 'equals', value: 'x' } };
    IO.cleanupElement(el, meta);
    expect(el.conditional).toBeUndefined();
  });

  it('keeps a conditional rule referencing a Choice column', () => {
    const el = { type: 'field', fieldName: 'Nom', conditional: { field: 'Statut', operator: 'notEquals', value: 'Actif' } };
    IO.cleanupElement(el, meta);
    expect(el.conditional).toEqual({ field: 'Statut', operator: 'notEquals', value: 'Actif' });
  });

  it('leaves elements with unknown columns untouched', () => {
    const el = { type: 'field', fieldName: 'Ghost', multiline: true, maxLength: 5 };
    IO.cleanupElement(el, meta);
    expect(el.multiline).toBe(true);
    expect(el.maxLength).toBe(5);
  });
});

describe('diffMissingColumns', () => {
  it('lists unknown columns uniquely, in first-seen order', () => {
    const elements = [
      { type: 'field', fieldName: 'A' },
      { type: 'field', fieldName: 'Nom' },
      { type: 'field', fieldName: 'B' },
      { type: 'field', fieldName: 'A' },
      { type: 'text', content: 'x' }
    ];
    expect(IO.diffMissingColumns(elements, meta)).toEqual(['A', 'B']);
  });
});

describe('planColumnRecreation', () => {
  it('builds AddColumn actions, preserving type, label and choices', () => {
    const elements = [
      { type: 'field', fieldName: 'Absent', columnType: 'Choice', columnChoices: ['X', 'Y'], columnLabel: 'Abs.' }
    ];
    const plan = IO.planColumnRecreation(['Absent'], elements, tables, 'Form');
    expect(plan.ok).toBe(true);
    expect(plan.actions).toEqual([[
      'AddColumn', 'Form', 'Absent',
      { type: 'Choice', label: 'Abs.', widgetOptions: JSON.stringify({ choices: ['X', 'Y'] }) }
    ]]);
  });

  it('plans simple types without widgetOptions', () => {
    const elements = [{ type: 'field', fieldName: 'Absent', columnType: 'Numeric' }];
    const plan = IO.planColumnRecreation(['Absent'], elements, tables, 'Form');
    expect(plan.ok).toBe(true);
    expect(plan.actions[0][3]).toEqual({ type: 'Numeric' });
  });

  it('refuses to recreate a Ref column whose target table does not exist', () => {
    const elements = [{ type: 'field', fieldName: 'Lien', columnType: 'Ref:Inconnue' }];
    const plan = IO.planColumnRecreation(['Lien'], elements, tables, 'Form');
    expect(plan.ok).toBe(false);
    expect(plan.unrecreatable[0]).toContain('Inconnue');
  });

  it('refuses to recreate without column type info (legacy export)', () => {
    const plan = IO.planColumnRecreation(['Absent'], [{ type: 'field', fieldName: 'Absent' }], tables, 'Form');
    expect(plan.ok).toBe(false);
    expect(plan.unrecreatable[0]).toContain('type inconnu');
  });
});

describe('round trip', () => {
  it('export → import preserves the configuration', () => {
    const original = {
      formElements: [
        { type: 'field', fieldName: 'Nom', fieldLabel: 'Votre nom', required: true, maxLength: 80 },
        { type: 'field', fieldName: 'Statut', fieldLabel: 'Statut', conditional: { field: 'Statut', operator: 'equals', value: 'Actif' } },
        { type: 'separator', content: '' },
        { type: 'text', content: 'Merci <b>beaucoup</b>' }
      ],
      globalFont: "'Marianne', sans-serif",
      globalPadding: 'medium'
    };

    const payload = IO.buildConfigPayload(original, meta);
    const json = JSON.stringify(payload, null, 2);
    const r = IO.normalizeImportedConfig(JSON.parse(json), {
      columnMetadata: meta, sanitize: identitySanitize
    });

    expect(r.ok).toBe(true);
    expect(r.missingColumns).toEqual([]);
    expect(r.config.globalFont).toBe(original.globalFont);
    expect(r.config.globalPadding).toBe(original.globalPadding);
    expect(r.config.formElements).toEqual([
      { type: 'field', fieldName: 'Nom', required: true, maxLength: 80, conditional: null, fieldLabel: 'Votre nom' },
      { type: 'field', fieldName: 'Statut', required: false, maxLength: null, fieldLabel: 'Statut',
        conditional: { field: 'Statut', operator: 'equals', value: 'Actif' } },
      { type: 'separator', content: '' },
      { type: 'text', content: 'Merci <b>beaucoup</b>' }
    ]);
  });
});
