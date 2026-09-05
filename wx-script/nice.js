/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 纳爱斯品质生活签到
cron: 22 13 * * *
------------------------------------------
变量名：nice
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("纳爱斯品质生活签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx231879a144b5879e";
const PAGE_VERSION = "290";
const API_BASE = "https://m.pailifan.com/xcx";
const BRAND_ID = 2655;
const TOKEN_CACHE_FILE = path.join(__dirname, "nice_token_cache.json");
const ENCRYPT_SALT = "tMFw=RXrEF7y^=7QXy2h2C_g_^";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "nice";

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

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex");
}

function formatDateTime(timestamp) {
    const d = new Date(timestamp * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function zeroPad(buffer) {
    const rest = buffer.length % 16;
    if (rest === 0) return buffer;
    return Buffer.concat([buffer, Buffer.alloc(16 - rest)]);
}

function encryptPayload(data) {
    const t = Math.floor(Date.now() / 1000);
    const date = formatDateTime(t);
    const key = Buffer.from(md5(ENCRYPT_SALT + date + t).substring(8, 24));
    const iv = Buffer.from(md5(date + t + ENCRYPT_SALT).substring(8, 24));
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    cipher.setAutoPadding(false);
    const input = zeroPad(Buffer.from(JSON.stringify(data), "utf8"));
    const encode = Buffer.concat([cipher.update(input), cipher.final()]).toString("base64");
    return { encode, t, bd: BRAND_ID };
}

function isTokenError(message) {
    return /40313|40317|unlogin|token|登录|授权|invalid/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.yyb = parseAccount(openid);
        this.openid = this.yyb ? this.yyb.ref : String(openid || "").trim();
        this.cacheId = this.yyb ? yybCacheKey(this.yyb.server, this.yyb.ref) : this.openid;
        this.wechat = this.yyb ? new WeChatServer({ url: this.yyb.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null;
        this.token = "";
        this.memberId = "";
        this.phone = "";
        this.todaySigned = false;
    }

    async run() {
        if (!this.yyb) {
            $.log(`账号[${this.index}] ❌ YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID）`);
            return;
        }
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getUser();
        await this.getSignLog();
        await this.doSign();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheId] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.cacheId] = {
            token: this.token,
            memberId: this.memberId,
            phone: this.phone,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.cacheId]) {
            delete cache[this.cacheId];
            writeTokenCache(cache);
        }
        this.token = "";
        this.memberId = "";
        this.phone = "";
    }

    applyToken(data = {}) {
        this.token = data.token || data.accessToken || "";
        this.memberId = data.memberId || data.member_id || "";
        this.phone = data.phone || data.mobile || "";
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "VERSION": "2022072802",
            "brand": "devtools",
            "model": "Windows",
            "platform": "windows",
            "system": "Windows 10",
            "deviceOrientation": "portrait",
            "version": "8.0.5",
            "size": "414,896",
            ...extra,
        };
    }

    buildPayload(data = {}) {
        return {
            ...data,
            b: BRAND_ID,
            lat: data.lat || "",
            lng: data.lng || "",
        };
    }

    async request(apiPath, data = {}, options = {}) {
        const payload = this.buildPayload(options.skipToken ? data : { token: this.token, ...data });
        const res = await axios.post(`${API_BASE}${apiPath}`, encryptPayload(payload), {
            headers: this.getHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const result = res.data;
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(result)}`);
        if (!result || result.flag !== 0) {
            const message = result?.msg || result?.data?.message || result?.data?.reason || JSON.stringify(result);
            const err = new Error(message);
            err.flag = result?.flag;
            throw err;
        }
        if (result?.data?.reason === "unlogin") {
            const err = new Error("unlogin");
            err.flag = result.flag;
            throw err;
        }
        return result.data;
    }

    async getLoginCode() {
        if (!this.wechat) throw new Error("YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID），无法获取 code");
        const { data } = await this.wechat.getCode(this.yyb.ref);
        return data.data.code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const data = await this.request("/v2/user_login", { code }, { skipToken: true });
            this.applyToken({
                token: data?.token,
                memberId: data?.member_id || data?.u,
                phone: data?.p,
            });
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${this.memberId || "未知"} ${maskPhone(this.phone) || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignLog(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUser() {
        try {
            const data = await this.request("/m/user");
            const user = data?.user || {};
            this.memberId = user.member_id || user.memberId || this.memberId;
            this.phone = user.phone || user.mobile || this.phone;
            this.saveCachedToken();
            $.log(`账号[${this.index}] 用户: memberId=${this.memberId || "未知"} ${maskPhone(this.phone) || ""}`);
        } catch (e) {
            const message = e.message || e;
            $.log(`账号[${this.index}] 查询用户失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async getSignLog(silent = false) {
        const data = await this.request("/u/signinlog");
        const info = data?.member_sign_info || {};
        const showDay = Number(info.show_day || 0);
        const totalCoins = info.zongCoin ?? data?.zongCoin ?? 0;
        this.todaySigned = Number(info.sign_today || 0) === 1;
        if (!silent) {
            $.log(`账号[${this.index}] 签到状态: ${this.todaySigned ? "今日已签" : "今日未签"} 连续${showDay}天 积分${totalCoins}`);
        }
        return data;
    }

    async doSign() {
        if (this.todaySigned) return;
        try {
            const data = await this.request("/u/signin", { data: "2019-09-23" });
            const signData = data?.data || {};
            $.log(`账号[${this.index}] 签到成功: +${signData.coin ?? "未知"} 当前积分${signData.total_coins ?? "未知"}`);
            await this.getSignLog(true);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|already/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                this.todaySigned = true;
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv("YYB_SERVER");
    const manualList = String(process.env[ckName] || "").split(/\r?\n|&/).map((item) => item.trim()).filter(Boolean);
    for (const item of manualList) if (!$.userList.includes(item)) $.userList.push(item);
    $.userCount = $.userList.length;
    if (!$.userCount) { $.log(`未找到变量 YYB_SERVER 或 ${ckName}`); return; }
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
