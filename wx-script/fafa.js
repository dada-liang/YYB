/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 发发藏宝洞 小程序签到
cron: 22 9 * * *
------------------------------------------
青龙变量：YYB_SERVER=yyb-go:8000@账号ID或OpenID
多账号用 & 或换行分隔，可在账号后加 #备注
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("发发藏宝洞小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wxd15ddc3916302f35";
const PAGE_VERSION = "99";
const APP_VERSION = "2.31.2";
const ENV_VERSION = "release";
const API_BASE = "https://smp-api.iyouke.com/dtapi";
const TOKEN_CACHE_FILE = path.join(__dirname, "fafa_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function parseYYBAccount(raw = "") {
    const text = String(raw).trim();
    const at = text.lastIndexOf("@");
    if (at <= 0) return { server: "", openid: "", remark: "" };
    const rawServer = text.slice(0, at).trim().replace(/\/$/, "");
    const [openid, remark] = text.slice(at + 1).split("#").map((v) => (v || "").trim());
    return { server: /^https?:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`, openid, remark: remark || "" };
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

function formatDate(date = new Date(), separator = "-") {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return [y, m, d].join(separator);
}

function normalizeAuthorization(value = "") {
    const token = String(value || "").trim();
    if (!token) return "";
    if (/^bearer/i.test(token)) return token;
    if (/^Bearer\s+/i.test(token)) return `bearer${token.replace(/^Bearer\s+/i, "")}`;
    return `bearer${token}`;
}

function maskMobile(mobile = "") {
    return String(mobile || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        const raw = String(account || "").trim();
        this.isDirectToken = /^token=/i.test(raw) || /^bearer/i.test(raw);
        this.account = this.isDirectToken ? { server: "", openid: "", remark: "" } : parseYYBAccount(raw);
        this.server = this.account.server;
        this.openid = this.account.openid;
        this.accessToken = "";
        this.authorization = "";
        this.userInfo = {};
        this.todayDate = formatDate();
        this.isTodaySign = false;
        if (this.isDirectToken) this.applyToken({ authorization: raw.replace(/^token=/i, "") });
    }

    async run() {
        if (!this.authorization) {
            const cached = this.getCachedToken();
            if (cached) {
                this.applyToken(cached);
                $.log(`账号[${this.index}] 使用缓存token`);
                if (!(await this.checkToken())) {
                    this.removeCachedToken();
                    $.log(`账号[${this.index}] 缓存token失效，重新登录`);
                }
            }
        }

        if (!this.authorization) {
            await this.loginByWxCode();
            if (!this.authorization) return;
        }
        // 未在本店铺注册：后续接口必然 401，直接结束，避免刷一串误导性失败
        if (this.unregistered) return;

        await this.getUserInfo();
        await this.getPointsInfo();
        await this.getSignList();
        await this.doSign();
        await this.getPointsInfo();
        this.saveCachedToken();
    }

    cacheKey() {
        return this.isDirectToken
            ? `token:${this.authorization.slice(-16)}`
            : yybCacheKey(this.server, this.openid);
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey()] || null;
    }

    saveCachedToken() {
        if (!this.authorization) return;
        const cache = readTokenCache();
        cache[this.cacheKey()] = {
            accessToken: this.accessToken,
            authorization: this.authorization,
            userId: this.userInfo.userId || "",
            nickName: this.userInfo.nickName || "",
            userMobile: this.userInfo.userMobile || "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        delete cache[this.cacheKey()];
        writeTokenCache(cache);
        this.accessToken = "";
        this.authorization = "";
        this.userInfo = {};
    }

    applyToken(data = {}) {
        this.accessToken = data.accessToken || data.access_token || "";
        this.authorization = normalizeAuthorization(data.authorization || this.accessToken);
        this.userInfo = { ...this.userInfo, ...data };
    }

    headers(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            appId: MINI_APP_ID,
            version: APP_VERSION,
            envVersion: ENV_VERSION,
            "xy-extra-data": `appid=${MINI_APP_ID};version=${APP_VERSION};envVersion=${ENV_VERSION};`,
            ...extra,
        };
        if (this.authorization) headers.Authorization = this.authorization;
        return headers;
    }

    async request({ method = "POST", apiPath, params = {}, data = {}, skipToken = false }) {
        const upperMethod = method.toUpperCase();
        const options = {
            method: upperMethod,
            url: `${API_BASE}${apiPath}`,
            headers: this.headers(upperMethod === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (upperMethod === "GET") options.params = params;
        else options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const res = await axios.request(options);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
        const result = res.data;
        if (result && typeof result === "object" && result.error !== undefined && Number(result.error) !== 0) {
            const err = new Error(result.errorMsg || result.message || result.msg || JSON.stringify(result));
            err.code = result.error;
            throw err;
        }
        return result?.data ?? result;
    }

    async getLoginCode() {
        if (!this.server || !this.openid) throw new Error("YYB_SERVER 格式无效");
        const { status, data } = await axios.post(`${this.server}/wxapp/getCode`, {
            ref: this.openid, app_id: MINI_APP_ID,
        }, {
            headers: { "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true,
        });
        const code = data?.data?.result?.code || data?.data?.code || data?.result?.code || data?.code;
        if (status !== 200 || !code || typeof code !== "string") throw new Error(`YYB Go 取 code 失败: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const data = await this.request({
                apiPath: "/appLogin",
                skipToken: true,
                data: {
                    appType: 1,
                    principal: code,
                },
            });
            this.applyToken(data);
            if (!this.authorization) throw new Error(`登录未返回token: ${JSON.stringify(data)}`);
            this.saveCachedToken();
            // 登录回 200 但不带 userId 时，拿到的是无效会话：随后所有业务接口都会
            // 401(token已失效/缺少token令牌)通常表示本次登录会话无效
            // (最常见，稍后重试即可)，或该微信号确实未在本店铺注册。都不该继续往下刷失败。
            if (!data.userId) {
                this.unregistered = true;
                $.log(`账号[${this.index}] ⚠️ 登录未返回 userId，会话无效；若持续如此则是该微信号未在本店铺注册`);
                return;
            }
            $.log(`账号[${this.index}] 登录成功: userId=${data.userId}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getUserInfo(false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUserInfo(log = true) {
        const data = await this.request({
            method: "GET",
            apiPath: "/p/user/userInfo",
        });
        this.userInfo = {
            ...this.userInfo,
            ...data,
        };
        this.saveCachedToken();
        if (log) {
            const name = data.nickName || data.memberName || data.userId || "未知";
            const mobile = data.userMobile || data.mobile || "";
            $.log(`账号[${this.index}] 用户: ${name}${mobile ? ` ${maskMobile(mobile)}` : ""}`);
        }
        return data;
    }

    async getPointsInfo() {
        try {
            const data = await this.request({
                method: "GET",
                apiPath: "/pointsSign/user/pointsInfo/query",
            });
            $.log(`账号[${this.index}] 积分: ${data?.pointsNums ?? "未知"} 连签=${data?.seriesDays ?? 0} 今日=${data?.signTodayResult ? "已签" : "未签"}`);
            return data;
        } catch (e) {
            const message = e.message || e;
            $.log(`账号[${this.index}] 查询积分失败: ${message}`);
            if (/token|登录|授权|401/i.test(String(message))) this.removeCachedToken();
        }
    }

    async getSignList() {
        try {
            const data = await this.request({
                method: "GET",
                apiPath: "/pointsSign/user/sign/list",
                params: { v4Flag: true },
            });
            const today = formatDate();
            const todayItem = Array.isArray(data) ? data.find((item) => item?.isToday || item?.dateStr === today) : null;
            this.todayDate = todayItem?.dateStr || today;
            this.isTodaySign = Number(todayItem?.daySignStatus) === 2 || Boolean(todayItem?.sign);
            $.log(`账号[${this.index}] 签到状态: ${this.todayDate} ${this.isTodaySign ? "已签" : "未签"}`);
        } catch (e) {
            const message = e.message || e;
            $.log(`账号[${this.index}] 查询签到状态失败: ${message}`);
            if (/token|登录|授权|401/i.test(String(message))) this.removeCachedToken();
        }
    }

    async doSign() {
        if (this.isTodaySign) {
            $.log(`账号[${this.index}] 今日已签到`);
            return;
        }
        try {
            const date = (this.todayDate || formatDate()).replace(/-/g, "/");
            const data = await this.request({
                method: "GET",
                apiPath: "/pointsSign/user/sign",
                params: { date },
            });
            $.log(`账号[${this.index}] 签到成功: +${data?.signReward ?? data?.reward ?? "未知"}积分`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签|重复|今日.*签/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (/token|登录|授权|401/i.test(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv();
    if (!$.userCount) {
        $.log("未配置 YYB_SERVER，格式：yyb-go:8000@账号ID或OpenID");
        return;
    }
    for (const account of $.userList) {
        await new Task(account).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
