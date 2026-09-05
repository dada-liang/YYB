/*
------------------------------------------
@Description: 小紫有约 - 微信小程序静默登录 + 每日签到
cron: 55 15 * * *
------------------------------------------
变量名：xzyy
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
YYB_SERVER     服务器地址@账号ID或OpenID，多账号换行或 & 分隔
------------------------------------------
契约（appid wx3db193ecdebd3fea，host sxkyziqidonglai.cn）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录）

登录  GET /api/platform/wechatAuthenticate?code&channelCode&siteId&deviceHash
        -> success && status==200，data.sessionId；session 放 cookie: SESSION=<id>
        （msg「请用手机号登录完善用户信息」= 未做手机号注册，签到会 401 身份校验失败）
用户  POST /api/mobile/eShop/eshopVipUser/getUserInfo (form) {siteId} -> status200，data.phone/balance；401=未登录/未注册
签到  POST /api/mobile/activity-v2/activity/launchByValidater (json) {actCode, siteId}
        -> status==200 成功；status==412 且含「已完成签到」= 已签
actCode：按月生成候选 SG{YY}{上月}{0-9} 逐个探测（原脚本机制，每月缓存）。
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("小紫有约签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "xzyy";
const MINI_APP_ID = "wx3db193ecdebd3fea";
const HOST = "sxkyziqidonglai.cn";
const BASE = `https://${HOST}`;
const CHANNEL_CODE = "WXjxriol8e8293wezu";
const DEVICE_HASH = "lkmtJuKGKQ0_S6Oem6ZIv3YoiHYGgoMf";
const SITE_ID = "SITE_33254242630091515087";
const SESSION_CACHE_FILE = path.join(__dirname, "xzyy_token_cache.json");
const ACTCODE_CACHE_FILE = path.join(__dirname, "xzyy_actcode_cache.json");
const UA = "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.5 MiniProgramEnv/android";

const API_WX_AUTH = "/api/platform/wechatAuthenticate";
const API_USER_INFO = "/api/mobile/eShop/eshopVipUser/getUserInfo";
const API_SIGN = "/api/mobile/activity-v2/activity/launchByValidater";

function readCache(file) {
    try {
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch (e) {
        return {};
    }
}
function writeCache(file, cache) {
    try {
        fs.writeFileSync(file, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入缓存失败: ${e.message || e}`);
    }
}
function parseAccount(raw = "") {
    const text = String(raw).trim(), at = text.lastIndexOf("@");
    if (at <= 0) return null;
    const rawServer = text.slice(0, at).trim().replace(/\/+$/, "");
    const identity = text.slice(at + 1), hash = identity.indexOf("#");
    const ref = (hash >= 0 ? identity.slice(0, hash) : identity).trim();
    const remark = (hash >= 0 ? identity.slice(hash + 1) : "").trim();
    if (!rawServer || !ref) return null;
    return { server: /^https?:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`, ref, openid: ref, remark };
}
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function commonHeaders(session) {
    const h = {
        "User-Agent": UA,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        origin: BASE,
        referer: `${BASE}/mall/personal?siteId=${SITE_ID}&channelCode=${CHANNEL_CODE}`,
        "x-requested-with": "com.tencent.mm",
    };
    if (session) h.cookie = `SESSION=${session}`;
    return h;
}
/** actCode 候选：SG + 两位年 + 上个月 + 0..9（原脚本机制） */
function generateCandidates() {
    const now = new Date();
    let lm = now.getMonth(); // getMonth 是 0..11，即“当前月-1”正好是上个月的月份数
    let year = now.getFullYear();
    if (lm === 0) { lm = 12; year -= 1; }
    const y2 = String(year % 100).padStart(2, "0");
    return Array.from({ length: 10 }, (_, i) => `SG${y2}${lm}${i}`);
}
function monthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw) || {};
        this.cacheId = yybCacheKey(this.account.server, this.account.ref);
        this.wechat = this.account.server ? new WeChatServer({ url: this.account.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null;
        this.session = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    async getCode() {
        const { data } = await this.wechat.getCode(this.account.ref);
        return data.data.code;
    }
    async login() {
        const code = await this.getCode();
        const res = await axios.request({
            method: "GET", url: `${BASE}${API_WX_AUTH}`,
            params: { code, channelCode: CHANNEL_CODE, siteId: SITE_ID, deviceHash: DEVICE_HASH },
            headers: commonHeaders(), timeout: 20000, validateStatus: () => true,
        });
        const d = res.data || {};
        if (!(d.success && Number(d.status) === 200) || !(d.data || {}).sessionId) {
            throw new Error(`登录失败: ${d.msg || short(d)}`);
        }
        this.session = d.data.sessionId;
        // 「请用手机号登录完善用户信息」= 未做手机号注册
        this.unregistered = /请用手机号登录|完善用户信息/.test(String(d.msg || ""));
        const cache = readCache(SESSION_CACHE_FILE);
        cache[this.cacheId] = { session: this.session, updatedAt: new Date().toISOString() };
        writeCache(SESSION_CACHE_FILE, cache);
        this.log(`登录成功${this.unregistered ? "（该微信号未做手机号注册）" : ""}`);
    }
    async checkUser() {
        const res = await axios.request({
            method: "POST", url: `${BASE}${API_USER_INFO}`,
            data: `siteId=${encodeURIComponent(SITE_ID)}`,
            headers: { ...commonHeaders(this.session), "content-type": "application/x-www-form-urlencoded" },
            timeout: 20000, validateStatus: () => true,
        });
        const rs = res.data || {};
        if (Number(rs.status) === 200) return { ok: true, phone: (rs.data || {}).phone, balance: (rs.data || {}).balance };
        return { ok: false, msg: rs.msg };
    }
    async trySign(actCode) {
        const res = await axios.request({
            method: "POST", url: `${BASE}${API_SIGN}`, data: { actCode, siteId: SITE_ID },
            headers: commonHeaders(this.session), timeout: 20000, validateStatus: () => true,
        });
        const rs = res.data || {};
        const status = Number(rs.status);
        const msg = String(rs.msg || "");
        if (rs.success || status === 200) return { done: true, already: false, msg };
        if (status === 412 && /已完成签到/.test(msg)) return { done: true, already: true, msg };
        return { done: false, status, msg };
    }
    /** 取本月缓存的 actCode，没有则用候选逐个探测 */
    async resolveActCodeAndSign() {
        const cache = readCache(ACTCODE_CACHE_FILE);
        const mk = monthKey();
        if (cache.month === mk && cache.actCode) {
            const r = await this.trySign(cache.actCode);
            if (r.done) return r;
            // 缓存失效则重新探测
        }
        const candidates = generateCandidates();
        this.log(`探测 actCode（${candidates[0]}..${candidates[candidates.length - 1]}）`);
        let lastMsg = "";
        for (const act of candidates) {
            const r = await this.trySign(act);
            lastMsg = r.msg;
            if (r.done) {
                writeCache(ACTCODE_CACHE_FILE, { month: mk, actCode: act });
                return r;
            }
            // 身份校验失败=账号未注册，无需继续探测
            if (Number(r.status) === 401) return { done: false, status: 401, msg: r.msg };
            await $.wait(1200, 2000);
        }
        return { done: false, msg: lastMsg || "未找到有效 actCode" };
    }
    async sign() {
        const u = await this.checkUser();
        if (!u.ok || this.unregistered) {
            return this.log(`⚠️ 该微信号还没在小紫有约做手机号注册（${u.msg || "未登录"}），先在小程序里手机号登录一次再跑`);
        }
        const r = await this.resolveActCodeAndSign();
        if (r.done && r.already) return this.log(`✅ 今日已签到（${r.msg}）`);
        if (r.done) return this.log(`✅ 签到成功`);
        if (Number(r.status) === 401) return this.log(`⚠️ 身份校验失败（${r.msg}），该微信号可能未完成注册`);
        this.log(`❌ 签到失败: ${r.msg}`);
    }
    async ensureLogin() {
        const cached = readCache(SESSION_CACHE_FILE)[this.cacheId] || {};
        if (!this.session && cached.session) {
            this.session = cached.session;
            // 用 getUserInfo 校验缓存 session 是否仍有效
            const u = await this.checkUser();
            if (u.ok) { this.log("使用缓存session"); return; }
            this.session = "";
        }
        if (!this.session) await this.login();
    }
    async run() {
        if (!this.account.ref) { this.log("❌ YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID）"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    $.checkEnv("YYB_SERVER");
    const manualList = String(process.env[ckName] || "").split(/\r?\n|&/).map((item) => item.trim()).filter(Boolean);
    for (const item of manualList) if (!$.userList.includes(item)) $.userList.push(item);
    $.userCount = $.userList.length;
    if (!$.userCount) { $.log(`未找到变量 YYB_SERVER 或 ${ckName}`); return; }
    if (!$.userCount) { $.log(`未找到变量 ${ckName}`); return; }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
