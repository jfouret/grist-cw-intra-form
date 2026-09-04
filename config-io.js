// =============================================================================
// CONFIG IMPORT/EXPORT — pure logic for the intra-form widget configuration.
// No DOM, Vue or Grist access here: everything is parameterized (metadata and
// sanitizer are passed in) so vitest can unit test it. Loaded as a plain
// script before app.js; app.js accesses it through window.IntraFormConfigIO.
// =============================================================================

(function () {

  const CONFIG_IO_WIDGET_ID = 'grist-cw-intra-form';
  const CONFIG_IO_VERSION = 1;

  // Meta-based field type helpers (single source of truth, reused by app.js)

  // Check if metadata indicates a text or numeric field (can have maxLength validation)
  function isTextOrNumericFieldByMeta(meta) {
    if (!meta) return false;
    return !meta.isBool && !meta.isDate && !meta.isDateTime && !meta.isMultiple && !meta.isAttachment &&
      (!meta.choices || meta.choices.length === 0) &&
      (!meta.isRef || meta.refChoices.length === 0);
  }

  // Check if metadata indicates a pure text field (can be multiline)
  function isPureTextFieldByMeta(meta) {
    if (!isTextOrNumericFieldByMeta(meta)) return false;
    return !meta.isNumeric && !meta.isInt;
  }

  // -------------------------------------------------------------------------
  // EXPORT
  // -------------------------------------------------------------------------

  // Build the JSON payload for export.
  // config: { formElements, globalFont, globalPadding }
  // columnMetadata: { colId: { type, choices, label, ... } }
  // Enriches each field element with column info (columnType, columnChoices,
  // columnLabel) so a later import can recreate missing columns if asked.
  function buildConfigPayload(config, columnMetadata) {
    const meta = columnMetadata || {};
    const formElements = (config.formElements || []).map(el => {
      const copy = JSON.parse(JSON.stringify(el));
      if (copy.type === 'field') {
        const colMeta = meta[copy.fieldName];
        copy.columnType = colMeta?.type || null;
        copy.columnChoices = colMeta?.choices || null;
        copy.columnLabel = colMeta?.label || copy.fieldName;
      }
      return copy;
    });

    return {
      widget: CONFIG_IO_WIDGET_ID,
      version: CONFIG_IO_VERSION,
      config: {
        formElements,
        globalFont: config.globalFont || '',
        globalPadding: config.globalPadding || ''
      }
    };
  }

  // -------------------------------------------------------------------------
  // IMPORT
  // -------------------------------------------------------------------------

  // Validate and normalize a pasted JSON payload.
  // opts: { columnMetadata, sanitize }
  // Returns { ok: true, config: { formElements, globalFont, globalPadding },
  //           missingColumns: [colId, ...] }
  // or     { ok: false, error: "message" }
  //
  // - Accepts the export envelope { widget, version, config } or a bare
  //   { formElements, ... } object (e.g. raw widget options).
  // - Sanitizes all HTML content (untrusted input rendered via v-html).
  // - Field elements referencing columns absent from columnMetadata are kept
  //   but reported in missingColumns (caller may recreate them, see
  //   planColumnRecreation).
  function normalizeImportedConfig(payload, opts) {
    const columnMetadata = opts?.columnMetadata || {};
    const sanitize = opts?.sanitize || ((s) => s);

    let config = null;
    let widget = null;
    let version = null;

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)) {
        widget = payload.widget ?? null;
        version = payload.version ?? null;
        config = payload.config;
      } else if (Array.isArray(payload.formElements)) {
        config = payload;
      }
    }

    if (!config || !Array.isArray(config.formElements)) {
      return { ok: false, error: 'JSON invalide : liste "formElements" introuvable.' };
    }

    if (widget !== null && widget !== CONFIG_IO_WIDGET_ID) {
      return { ok: false, error: 'JSON invalide : cette configuration provient d\u2019un autre widget (' + widget + ').' };
    }

    const numVersion = Number(version);
    if (version !== null && (!Number.isFinite(numVersion) || numVersion > CONFIG_IO_VERSION)) {
      return { ok: false, error: 'Version de configuration non support\u00e9e : ' + version + '.' };
    }

    const missingColumns = [];
    const elements = [];

    for (const el of config.formElements) {
      if (!el || typeof el !== 'object' || Array.isArray(el)) continue;

      if (el.type === 'separator') {
        elements.push({ type: 'separator', content: '' });
        continue;
      }

      if (el.type === 'text') {
        const content = typeof el.content === 'string' ? el.content : '';
        elements.push({ type: 'text', content: sanitize(content) });
        continue;
      }

      if (el.type === 'field') {
        if (typeof el.fieldName !== 'string' || !el.fieldName) continue;

        const known = !!columnMetadata[el.fieldName];
        if (!known && !missingColumns.includes(el.fieldName)) {
          missingColumns.push(el.fieldName);
        }

        const norm = {
          type: 'field',
          fieldName: el.fieldName,
          required: !!el.required,
          maxLength: normalizeMaxLength(el.maxLength),
          conditional: normalizeConditional(el.conditional, columnMetadata, known)
        };

        const label = typeof el.fieldLabel === 'string' && el.fieldLabel
          ? sanitize(el.fieldLabel)
          : (known ? (columnMetadata[el.fieldName].label || el.fieldName) : el.fieldName);
        if (label) norm.fieldLabel = label;

        if (el.multiline === true) norm.multiline = true;

        // Column info used only to recreate a missing column
        if (!known) {
          if (typeof el.columnType === 'string' && el.columnType) {
            norm.columnType = el.columnType;
          }
          if (Array.isArray(el.columnChoices) && el.columnChoices.length) {
            norm.columnChoices = el.columnChoices.filter(
              c => typeof c === 'string' || typeof c === 'number'
            );
          }
          if (typeof el.columnLabel === 'string' && el.columnLabel) {
            norm.columnLabel = el.columnLabel;
          }
        }

        if (known) cleanupElement(norm, columnMetadata);
        elements.push(norm);
      }
      // Unknown element types are silently dropped
    }

    return {
      ok: true,
      config: {
        formElements: elements,
        globalFont: sanitizeFont(config.globalFont),
        globalPadding: normalizePadding(config.globalPadding)
      },
      missingColumns
    };
  }

  // Normalize maxLength to a positive integer or null
  function normalizeMaxLength(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Normalize a conditional rule; returns null when invalid.
  // Unknown condition fields are only kept if the referenced column exists
  // in columnMetadata (cleanupElement re-checks choice validity).
  function normalizeConditional(conditional, columnMetadata, knownColumnsOnly) {
    if (!conditional || typeof conditional !== 'object') return null;
    const field = conditional.field;
    const operator = conditional.operator;
    const value = conditional.value;
    if (typeof field !== 'string' || !field) return null;
    if (knownColumnsOnly && !columnMetadata[field]) return null;
    if (operator !== 'equals' && operator !== 'notEquals') return null;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    return { field, operator, value: value };
  }

  // Whitelist padding value
  function normalizePadding(value) {
    return ['small', 'medium', 'large'].includes(value) ? value : '';
  }

  // Keep only characters valid in a CSS font-family list
  function sanitizeFont(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[^A-Za-z0-9 ,'"-]/g, '').slice(0, 200);
  }

  // Clean up invalid properties of a field element based on column metadata
  // (shared by load-time sanitization and import).
  // Missing metadata (unknown column) is left untouched: the caller decides.
  function cleanupElement(el, columnMetadata) {
    if (!el || el.type !== 'field') return el;
    const meta = columnMetadata[el.fieldName];
    if (!meta) return el;

    // multiline: only valid for pure text fields
    if (el.multiline && !isPureTextFieldByMeta(meta)) {
      delete el.multiline;
    }

    // maxLength: only valid for text/numeric fields
    if (el.maxLength != null && !isTextOrNumericFieldByMeta(meta)) {
      delete el.maxLength;
    }

    // conditional: verify that the referenced field is still a valid condition field
    if (el.conditional) {
      const condMeta = columnMetadata[el.conditional.field];
      const isValidConditionField = condMeta && (
        (condMeta.choices?.length > 0 && !condMeta.isMultiple) ||
        (condMeta.isRef && !condMeta.isMultiple && condMeta.refChoices?.length > 0)
      );
      if (!isValidConditionField) {
        delete el.conditional;
      }
    }

    return el;
  }

  // List fieldNames referenced by field elements but absent from columnMetadata
  // (unique, in first-seen order).
  function diffMissingColumns(formElements, columnMetadata) {
    const missing = [];
    for (const el of formElements || []) {
      if (el && el.type === 'field' && el.fieldName &&
          !columnMetadata[el.fieldName] && !missing.includes(el.fieldName)) {
        missing.push(el.fieldName);
      }
    }
    return missing;
  }

  // Build AddColumn user actions to recreate missing columns.
  // missingColumns: [colId, ...] (from normalizeImportedConfig)
  // formElements:   normalized elements (missing ones carry columnType/columnChoices)
  // knownTableIds:  [tableId, ...] existing tables in the document
  // tableId:        target table for AddColumn actions
  // Returns { ok: true, actions } or { ok: false, unrecreatable: [reason, ...] }
  function planColumnRecreation(missingColumns, formElements, knownTableIds, tableId) {
    const known = new Set(knownTableIds || []);
    const byName = {};
    for (const el of formElements || []) {
      if (el?.type === 'field' && missingColumns.includes(el.fieldName) && !(el.fieldName in byName)) {
        byName[el.fieldName] = el;
      }
    }

    const actions = [];
    const unrecreatable = [];

    for (const colId of missingColumns) {
      const el = byName[colId];
      const colType = el?.columnType;

      if (!colType || typeof colType !== 'string') {
        unrecreatable.push(colId + ' (type inconnu)');
        continue;
      }

      let refTable = null;
      if (colType.startsWith('Ref:')) refTable = colType.slice(4);
      else if (colType.startsWith('RefList:')) refTable = colType.slice(8);
      if (refTable && !known.has(refTable)) {
        unrecreatable.push(colId + ' (table cible "' + refTable + '" introuvable)');
        continue;
      }

      const colInfo = { type: colType };
      if (el.columnLabel) colInfo.label = el.columnLabel;
      if (Array.isArray(el.columnChoices) && el.columnChoices.length) {
        colInfo.widgetOptions = JSON.stringify({ choices: el.columnChoices });
      }
      actions.push(['AddColumn', tableId, colId, colInfo]);
    }

    if (unrecreatable.length > 0) {
      return { ok: false, unrecreatable };
    }
    return { ok: true, actions };
  }

  window.IntraFormConfigIO = {
    CONFIG_IO_WIDGET_ID,
    CONFIG_IO_VERSION,
    isTextOrNumericFieldByMeta,
    isPureTextFieldByMeta,
    buildConfigPayload,
    normalizeImportedConfig,
    cleanupElement,
    diffMissingColumns,
    planColumnRecreation
  };

})();
