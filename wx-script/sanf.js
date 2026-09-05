/*
------------------------------------------
@Description: 三福会员 - 微信小程序静默登录 + 每日签到
cron: 28 14 * * *
------------------------------------------
变量名：sanf
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
YYB_SERVER     服务器地址@账号ID或OpenID，多账号换行或 & 分隔
------------------------------------------
契约（appid wxfe13a2a5df88b058，host crm.sanfu.com）：
（迁移自 YYB-GO 系脚本，原脚本已 code 登录；鉴权用 sid，放在每个请求 body 里）

登录  POST /ms-sanfu-wechat-customer-core/customer/core/wxMiniAppLogin
        {code, appid, shoId:"", userId:"", sourceWxsceneid:1027, sourceUrl:"pages/ucenter_index/ucenter_index"}
        -> code==200，data.sid
签到  POST /ms-sanfu-wechat-common/customer/onSign  {signWay:0, sid}
        -> code==200，data.fubi / data.onKeepSignDay；重复签到 code!=200 带提示
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("三福会员签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "sanf";
const MINI_APP_ID = "wxfe13a2a5df88b058";
const BASE = "https://crm.sanfu.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "sanf_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const EP_LOGIN = "/ms-sanfu-wechat-customer-core/customer/core/wxMiniAppLogin";
const EP_SIGN = "/ms-sanfu-wechat-common/customer/onSign";

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}
function writeCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
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

const isAlreadyDone = (t) => /已签|已经签|签到过|重复|已完成|already/i.test(String(t || ""));

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw) || {};
        this.cacheId = yybCacheKey(this.account.server, this.account.ref);
        this.wechat = this.account.server ? new WeChatServer({ url: this.account.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null;
        this.sid = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    async request(apiPath, body) {
        const res = await axios.request({
            method: "POST", url: `${BASE}${apiPath}`, data: body || {},
            headers: {
                Host: "crm.sanfu.com", "Content-Type": "application/json",
                "User-Agent": USER_AGENT, xweb_xhr: "1", Accept: "*/*",
                Referer: `https://servicewechat.com/${MINI_APP_ID}/385/page-frame.html`,
            },
            timeout: 20000, validateStatus: () => true,
        });
        if (res.status !== 200) {
            if (res.data && typeof res.data === "object") return res.data;
            throw new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
        }
        return res.data;
    }
    async getCode() {
        const { data } = await this.wechat.getCode(this.account.ref);
        return data.data.code;
    }
    async login() {
        const code = await this.getCode();
        const res = await this.request(EP_LOGIN, { code, appid: MINI_APP_ID, shoId: "", userId: "", sourceWxsceneid: 1027, sourceUrl: "pages/ucenter_index/ucenter_index" });
        if (Number(res?.code) !== 200) throw new Error(`登录失败: ${res?.msg || short(res)}`);
        this.sid = String((res.data || {}).sid || "");
        if (!this.sid) throw new Error(`登录未返回 sid: ${short(res)}`);
        const cache = readCache();
        cache[this.cacheId] = { sid: this.sid, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async sign(retry = true) {
        const res = await this.request(EP_SIGN, { signWay: 0, sid: this.sid });
        if (Number(res?.code) === 200) {
            const d = res.data || {};
            return this.log(`✅ 签到成功，连续 ${d.onKeepSignDay ?? "?"} 天，获得 ${d.fubi ?? "?"} 福币`);
        }
        const msg = res?.msg || res?.message || short(res);
        if (isAlreadyDone(msg)) return this.log(`✅ 今日已签到（${msg}）`);
        if (retry && /登录|sid|未授权|失效|过期|未登录|401/i.test(msg)) {
            this.log("会话失效，重新登录后重试");
            this.sid = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: ${msg}`);
    }
    async ensureLogin() {
        const cached = readCache()[this.cacheId] || {};
        if (!this.sid && cached.sid) { this.sid = cached.sid; this.log("使用缓存sid"); return; }
        if (!this.sid) await this.login();
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
