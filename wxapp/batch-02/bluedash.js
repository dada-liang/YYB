/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: BLUE DASH 布鲁大师小程序签到
cron: 30 8 * * *
------------------------------------------
青龙变量：YYB_SERVER=yyb-go:8000@账号ID或OpenID
多账号用 & 或换行分隔，可在账号后加 #备注
------------------------------------------
*/

const { Env, yybCacheKey } = require("../tools/env.js");
const $ = new Env("BLUE DASH 布鲁大师签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wx73555499305578f8";
const API_BASE = "https://wxsc.blue-dash.com/prod-api";
const LOGIN_TYPE = "34";
const LOGIN_STATE = "blue_dash";
const TOKEN_CACHE_FILE = path.join(__dirname, "bluedash_token_cache.json");
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

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        const account = parseYYBAccount(raw);
        this.server = account.server;
        this.openid = account.openid;
        this.remark = account.remark;
        this.cacheKey = yybCacheKey(this.server, this.openid);
        this.authorization = "";
        this.refreshToken = "";
        this.user = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.authorization) {
            await this.loginByWxCode();
            if (!this.authorization) return;
        }

        await this.getSignList();
        await this.doSign();
        await this.getUser();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey] || null;
    }

    saveCachedToken() {
        if (!this.authorization) return;
        const cache = readTokenCache();
        cache[this.cacheKey] = {
            authorization: this.authorization,
            refreshToken: this.refreshToken,
            nickname: this.user.nickname || "",
            mobile: this.user.mobile || "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.cacheKey]) {
            delete cache[this.cacheKey];
            writeTokenCache(cache);
        }
        this.authorization = "";
        this.refreshToken = "";
    }

    applyToken(data = {}) {
        const accessToken = data.accessToken || data.access_token || "";
        this.authorization = data.authorization || data.Authorization || (accessToken ? `Bearer ${accessToken}` : "");
        this.refreshToken = data.refreshToken || data.refresh_token || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/39/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
        if (this.authorization) headers.Authorization = this.authorization;
        return headers;
    }

    async request({ method = "GET", apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = params;
        else options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const message = result?.msg || result?.message || JSON.stringify(result);
            const err = new Error(message);
            err.code = result?.code;
            throw err;
        }
        return result.data;
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
                method: "POST",
                apiPath: "/app-api/member/auth/social-login",
                skipToken: true,
                data: {
                    code,
                    type: LOGIN_TYPE,
                    state: LOGIN_STATE,
                },
            });
            this.applyToken(data);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getUser();
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUser() {
        const data = await this.request({ apiPath: "/app-api/member/user/get" });
        this.user = data || {};
        this.saveCachedToken();
        $.log(`账号[${this.index}] 用户: ${data?.nickname || ""} ${maskPhone(data?.mobile) || ""} 积分=${data?.score ?? "未知"}`);
        return data;
    }

    async getSignList() {
        try {
            const data = await this.request({
                apiPath: "/app-api/member/sign-log/page",
                params: {
                    pageNo: 1,
                    pageSize: 100,
                },
            });
            const list = data?.pageResult?.list || [];
            const today = new Date().toISOString().slice(0, 10);
            this.isTodaySign = list.some((item) => item?.date === today);
            $.log(`账号[${this.index}] 签到记录: 连续${data?.coiledDay || 0}天 今日=${this.isTodaySign ? "已签" : "未签"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到记录失败: ${e.message || e}`);
            if (e.code === 401 || /token|登录|授权/i.test(String(e.message || e))) this.removeCachedToken();
        }
    }

    async doSign() {
        if (this.isTodaySign) {
            $.log(`账号[${this.index}] 今日已签到`);
            return;
        }
        try {
            const data = await this.request({
                method: "POST",
                apiPath: "/app-api/member/sign-log/sign",
            });
            $.log(`账号[${this.index}] 签到成功: +${data?.score ?? data ?? "未知"}积分`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|今日.*签/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (e.code === 401 || /token|登录|授权/i.test(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv();
    if (!$.userCount) {
        $.log("未配置 YYB_SERVER，格式：yyb-go:8000@账号ID或OpenID");
        return;
    }
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
