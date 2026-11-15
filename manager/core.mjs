import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PROJECT = '/home/deploy/МП Выход';

async function jsonAt(root, relative, fallback, missing) {
  try {
    return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  } catch (error) {
    missing.push({file: relative, reason: error?.code === 'ENOENT' ? 'Файл отсутствует' : 'Не удалось прочитать JSON'});
    return fallback;
  }
}

const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
const sum = (rows, field) => rows.reduce((n, row) => n + (finiteNumber(row[field]) || 0), 0);

export async function buildSnapshot(root = DEFAULT_PROJECT, now = new Date()) {
  const missing = [];
  const [skuRows, siteFacts, siteCards, readiness, matches, validations, tariffs] = await Promise.all([
    jsonAt(root, 'data/skus.json', [], missing),
    jsonAt(root, 'data/site_cards_input.json', [], missing),
    jsonAt(root, 'cards/site_cards.json', [], missing),
    jsonAt(root, 'data/site_readiness.json', {}, missing),
    jsonAt(root, 'data/site_matches.json', [], missing),
    jsonAt(root, 'reports/validation.json', [], missing),
    jsonAt(root, 'data/tariffs.json', {}, missing)
  ]);
  const skus = (Array.isArray(skuRows) ? skuRows : []).map(item => ({
    code: String(item.code || ''),
    name: String(item.product || ''),
    category: String(item.category || ''),
    variant: String(item.variant || ''),
    cost: finiteNumber(item.cost),
    price: finiteNumber(item.ozon),
    stock: finiteNumber(item.stock_total),
    stockSpb: finiteNumber(item.stock_spb),
    stockObuh: finiteNumber(item.stock_obuh)
  }));
  const cardMap = new Map((Array.isArray(siteCards) ? siteCards : []).map(card => [card.id, card]));
  const validationMap = new Map((Array.isArray(validations) ? validations : []).map(x => [x.id + ':' + x.platform, x]));
  const matchMap = new Map((Array.isArray(matches) ? matches : []).map(x => [x.site?.url, x]));
  const skuCodes = new Set(skus.map(x => x.code));
  const cards = (Array.isArray(siteFacts) ? siteFacts : []).map(item => {
    const id = String(item.id || '');
    const entry = cardMap.get(id) || {};
    const status = readiness[id] || {};
    const candidates = (matchMap.get(item.url)?.cands || []).slice(0, 6).map(candidate => ({
      code: String(candidate.code || ''),
      name: String(candidate.name || ''),
      score: finiteNumber(candidate.score),
      inSelected1C: skuCodes.has(candidate.code)
    }));
    const problems = Array.isArray(status.reasons) ? status.reasons.map(x => typeof x === 'string' ? x : x.text).filter(Boolean) : [];
    const photos = Array.isArray(item.images) ? item.images.length : 0;
    const checks = ['ozon', 'wb'].map(platform => ({
      platform, errors: validationMap.get(id + ':' + platform)?.errors || []
    }));
    return {
      id,
      name: String(item.name || ''),
      category: String(item.section || ''),
      sourceUrl: String(item.url || ''),
      price: finiteNumber(item.price),
      stock: null,
      cost: null,
      // Candidates are suggestions, NOT a confirmed 1C match.
      matched1cCode: null,
      candidates,
      photos,
      photo: photos ? '/media/' + encodeURIComponent(id) + '/01.jpg' : null,
      readiness: String(status.status || 'не проверено'),
      problems,
      gaps: (status.gaps || []).slice(0, 12).map(String),
      checked: checks,
      draft: {
        ozon: {title: String(entry.ozon?.title || ''), description: String(entry.ozon?.description || '')},
        wb: {title: String(entry.wb?.title || ''), description: String(entry.wb?.description || '')}
      }
    };
  });
  let skuMtime = null;
  try {skuMtime = (await stat(path.join(root, 'data/skus.json'))).mtime.toISOString();} catch {}
  const readyCount = cards.filter(c => c.readiness === 'готово').length;
  const verified = cards.filter(c => c.checked.every(x => x.errors.length === 0)).length;
  return {
    generatedAt: now.toISOString(),
    source: 'Локальные снимки 1С и Stolberi; не данные маркетплейса в реальном времени',
    skuMtime,
    skuDataStale: !skuMtime || now.getTime() - new Date(skuMtime).getTime() > 24 * 60 * 60 * 1000,
    tariffsDate: tariffs.updated || null,
    tariffNote: String(tariffs.status || 'Рабочие оценки; тарифы не подтверждены'),
    missing,
    stats: {skuVariants: skus.length, oneCStock: sum(skus, 'stock'), siteCards: cards.length, photos: sum(cards, 'photos'), contentReady: readyCount, textValidated: verified},
    skus,
    cards
  };
}

export function applyApproval(existing, id, decision, when = new Date()) {
  if (!/^S(0[1-9]|1[0-6])$/.test(id)) throw new Error('Некорректный ID карточки');
  if (!['reviewed', 'needs_work', 'reset'].includes(decision)) throw new Error('Некорректное решение');
  const next = {...existing};
  if (decision === 'reset') delete next[id];
  else next[id] = {decision, at: when.toISOString(), note: 'Решение только по черновику; не публикация'};
  return next;
}

export function summarizeOzon(body, statusCode) {
  if (statusCode !== 200) return {ok: false, statusCode, message: statusCode === 401 || statusCode === 403 ? 'Ozon отклонил доступ: проверьте Client ID, ключ и его права' : 'Ozon вернул ошибку HTTP ' + statusCode};
  const items = body?.result?.items;
  if (!Array.isArray(items)) return {ok: false, statusCode, message: 'Неожиданный формат ответа Ozon'};
  return {
    ok: true, statusCode,
    countOnPage: items.length,
    totalItems: finiteNumber(body.result.total_items),
    nextPage: Boolean(body.result.last_id),
    products: items.slice(0, 100).map(item => ({
      offerId: String(item.offer_id || ''),
      productId: String(item.product_id ?? ''),
      hasFboStocks: Boolean(item.has_fbo_stocks),
      hasFbsStocks: Boolean(item.has_fbs_stocks)
    }))
  };
}

export async function checkOzon(clientId, apiKey, fetcher = fetch) {
  if (!/^\d{3,20}$/.test(clientId) || !apiKey) throw new Error('Нужны Client ID и API-ключ Ozon');
  const response = await fetcher('https://api-seller.ozon.ru/v3/product/list', {
    method: 'POST',
    headers: {'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json'},
    body: JSON.stringify({filter: {visibility: 'ALL'}, last_id: '', limit: 100}),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) return summarizeOzon(null, response.status);
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error('Слишком большой ответ Ozon');
  let json;
  try {json = JSON.parse(raw);} catch {throw new Error('Ozon вернул некорректный JSON');}
  return summarizeOzon(json, response.status);
}
