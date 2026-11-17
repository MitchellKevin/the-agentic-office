// Model -> price / context-window lookup and per-usage cost estimation.
// All prices are USD per million tokens and are estimates (see config.json).

export function normalizeModel(model) {
  if (!model) return '';
  return String(model)
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')          // "opus[1m]" -> "opus"
    .replace(/^(us|eu|apac|global)\./, '') // bedrock cross-region prefixes
    .replace(/^anthropic\./, '')
    .replace(/@.*$/, '');               // vertex "@20251101"
}

export function priceFor(model, cfg) {
  const m = normalizeModel(model);
  const table = cfg.pricing || [];
  for (const row of table) {
    if (row.match && m.includes(row.match)) return withDefaults(row, false);
  }
  return withDefaults(cfg.fallbackPricing || { input: 0, output: 0, cacheRead: 0 }, true);
}

function withDefaults(row, unpriced) {
  return {
    match: row.match || null,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead ?? row.input * 0.1,
    cacheWrite5m: row.cacheWrite5m ?? row.input * 1.25,
    cacheWrite1h: row.cacheWrite1h ?? row.input * 2,
    unpriced,
  };
}

export function contextWindowFor(model, cfg, observed = 0) {
  const m = normalizeModel(model);
  let win = 200000;
  for (const row of cfg.contextWindows || []) {
    if (m.includes(row.match)) { win = row.tokens; break; }
  }
  // Claude Code can run models with an extended window ("[1m]"); if we've seen
  // more context than the table allows, the window must be bigger.
  if (observed > win) win = observed > 1000000 ? Math.ceil(observed / 1e6) * 1e6 : 1000000;
  return win;
}

// Normalise an API usage object into the counters we track.
export function usageTokens(u) {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const write = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || null;
  let w1h = 0, w5m = write;
  if (cc && (cc.ephemeral_1h_input_tokens != null || cc.ephemeral_5m_input_tokens != null)) {
    w1h = cc.ephemeral_1h_input_tokens || 0;
    w5m = cc.ephemeral_5m_input_tokens || 0;
    // Guard against the split not adding up to the total.
    if (w1h + w5m < write) w5m += write - (w1h + w5m);
  }
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
  };
}

export function costOf(tokens, price) {
  return (
    tokens.input * price.input +
    tokens.output * price.output +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite5m * price.cacheWrite5m +
    tokens.cacheWrite1h * price.cacheWrite1h
  ) / 1e6;
}
