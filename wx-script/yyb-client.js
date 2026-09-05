function normalizeServer(server = "") {
  const value = String(server).trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function parseAccount(raw = "", fallbackServer = "") {
  const text = String(raw).trim();
  const at = text.lastIndexOf("@");
  const server = at > 0 ? text.slice(0, at) : fallbackServer;
  const identity = at > 0 ? text.slice(at + 1) : text;
  const hash = identity.indexOf("#");
  const ref = (hash >= 0 ? identity.slice(0, hash) : identity).trim();
  const remark = (hash >= 0 ? identity.slice(hash + 1) : "").trim();
  return { server: normalizeServer(server), ref, openid: ref, remark };
}

function cacheKey(account) {
  return `${normalizeServer(account?.server).toLowerCase()}@${String(account?.ref || account?.openid || "").trim()}`;
}

function parseRaw(value) {
  if (!value || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function extractCode(payload = {}) {
  const result = payload?.result;
  const nested = payload?.data?.result;
  const candidates = [result, nested, result?.raw, nested?.raw, payload?.data, payload];
  for (const candidate of candidates) {
    const item = parseRaw(candidate);
    if (item && typeof item === "object" && typeof item.code === "string" && item.code) return item.code;
  }
  return "";
}

function responseCandidates(payload = {}) {
  const result = payload?.result;
  const nested = payload?.data?.result;
  return [result, nested, result?.raw, nested?.raw, payload?.data, payload]
    .map(parseRaw)
    .filter((item) => item && typeof item === "object");
}

function extractPhoneData(payload = {}) {
  const output = { code: "", phoneCode: "", iv: "", encryptedData: "", encrypted_data: "", raw: {} };
  for (const item of responseCandidates(payload)) {
    output.code ||= item.code || item.phoneCode || item.phone_code || "";
    output.phoneCode ||= item.phoneCode || item.phone_code || item.code || "";
    output.iv ||= item.iv || item.IV || "";
    output.encryptedData ||= item.encryptedData || item.encrypted_data || "";
    output.encrypted_data ||= item.encrypted_data || item.encryptedData || "";
    if (!Object.keys(output.raw).length && item.raw) output.raw = parseRaw(item.raw) || {};
  }
  return output;
}

async function postYYB(account, path, body, options = {}) {
  if (!account?.server || !account?.ref) throw new Error("YYB账号格式无效，应为 服务器地址@账号ID或OpenID");
  const axios = options.axios || require("axios");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (process.env.wx_auth && !headers.auth) headers.auth = process.env.wx_auth;
  const response = await axios.post(
    `${account.server}${path}`,
    body,
    { headers, timeout: options.timeout || 30000, validateStatus: () => true }
  );
  if (response.status !== 200) {
    throw new Error(`YYB请求失败: HTTP ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function getCodeData(account, appId, options = {}) {
  const payload = await postYYB(account, "/wxapp/getCode", { ref: account.ref, app_id: appId }, options);
  const code = extractCode(payload);
  if (!code) throw new Error(`YYB未返回code: ${JSON.stringify(payload)}`);
  const openid = String(payload?.openid || payload?.data?.openid || account.ref || "");
  return { code, openid, raw: payload };
}

async function getCode(account, appId, options = {}) {
  return (await getCodeData(account, appId, options)).code;
}

async function getPhoneNumber(account, appId, options = {}) {
  const payload = await postYYB(account, "/wxapp/getPhoneNumber", { ref: account.ref, app_id: appId }, options);
  const result = extractPhoneData(payload);
  if (!result.code && !result.iv && !result.encryptedData) {
    throw new Error(`YYB未返回手机号授权数据: ${JSON.stringify(payload)}`);
  }
  return result;
}

async function getUserInfo(account, options = {}) {
  const payload = await postYYB(account, "/wx/getuserinfo", { ref: account.ref }, options);
  const selected = payload?.result || payload?.data?.result || payload?.user_info || payload?.data?.user_info || payload?.data || payload || {};
  const result = parseRaw(selected) || {};
  const raw = parseRaw(result?.raw);
  return raw && typeof raw === "object" ? { ...result, ...raw, raw } : result;
}

function accountEnv(legacyName) {
  return process.env.YYB_SERVER || process.env[legacyName] || "";
}

module.exports = {
  accountEnv, cacheKey, extractCode, extractPhoneData, getCode, getCodeData, getPhoneNumber, getUserInfo,
  normalizeServer, parseAccount, postYYB,
};
