/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description: 爱果乐之家微信小程序签到
cron: 30 8 * * *
------------------------------------------
青龙变量：YYB_SERVER=yyb-go:8000@账号ID或OpenID
多账号用 & 或换行分隔，可在账号后加 #备注
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("爱果乐之家微信小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

const MINI_APP_ID = "wxa1086b8081476f46";
const KDT_ID = "18774683";
const USER_VERSION = "2.195.7.101";
const CLIENT_ID = "4d65249d377b2c3ed8";
const CLIENT_SECRET = "1cdc05151d64f3a4a6ebd0e9de64422a";
const GRANT_TYPE = "yz_union";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "aiguoyue_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function parseYYBAccount(raw = "") {
    const text = String(raw).trim();
    const at = text.lastIndexOf("@");
    if (at <= 0) return { server: "", openid: "", remark: "" };
    const rawServer = text.slice(0, at).trim().replace(/\/$/, "");
    const [openid, remark] = text.slice(at + 1).split("#").map((v) => (v || "").trim());
    return {
        server: /^https?:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`,
        openid, remark: remark || "",
    };
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

function maskToken(token = "") {
    if (!token) return "";
    return token.length > 12 ? `${token.slice(0, 6)}***${token.slice(-6)}` : `${token.slice(0, 3)}***`;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        const account = parseYYBAccount(raw);
        this.server = account.server;
        this.openid = account.openid;
        this.remark = account.remark;
        this.cacheKey = yybCacheKey(this.server, this.openid);
        this.token = {};
        this.checkinId = "";
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            $.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.accessToken)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新code登录`);
            }
        }

        if (!this.accessToken) {
            await this.loginByWxCode();
        }
        if (!this.accessToken) return;

        await this.getPoints("签到前");
        await this.getCheckinInfo();
        await this.getActivityInfo();
        await this.doCheckin();
        await this.getPoints("签到后");
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey] || null;
    }

    saveCachedToken() {
        if (!this.accessToken) return;
        const cache = readTokenCache();
        cache[this.cacheKey] = {
            ...this.token,
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
        this.token = {};
    }

    get accessToken() {
        return this.token.accessToken || this.token.access_token || "";
    }

    get sessionId() {
        return this.token.sessionId || this.token.session_id || "";
    }

    buildExtraData() {
        return JSON.stringify({
            is_weapp: 1,
            sid: this.sessionId,
            version: USER_VERSION,
            client: "weapp",
            bizEnv: "wsc",
        });
    }

    buildUrl(apiPath, query = {}) {
        const pathname = apiPath.replace(/^\/+/, "");
        const params = querystring.stringify({
            store_id: "",
            app_id: MINI_APP_ID,
            kdt_id: KDT_ID,
            access_token: this.accessToken,
            ...query,
        });
        return `${API_BASE}/${pathname}?${params}`;
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/3/page-frame.html`,
            "Extra-Data": this.buildExtraData(),
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
    }

    async request({ method = "GET", apiPath, query = {}, data = {}, skipToken = false }) {
        const oldToken = this.token;
        if (skipToken) this.token = {};
        const options = {
            method,
            url: this.buildUrl(apiPath, query),
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method !== "GET") options.data = data;
        if (skipToken) this.token = oldToken;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    async getWxCode() {
        if (!this.server || !this.openid) throw new Error("YYB_SERVER 格式无效");
        const { status, data } = await axios.post(`${this.server}/wxapp/getCode`, {
            ref: this.openid,
            app_id: MINI_APP_ID,
        }, {
            headers: { "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true,
        });
        const code = data?.data?.result?.code || data?.data?.code || data?.result?.code || data?.code;
        if (status !== 200 || !code || typeof code !== "string") {
            throw new Error(`YYB Go 取 code 失败: HTTP ${status} ${JSON.stringify(data)}`);
        }
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            const data = await this.request({
                method: "POST",
                apiPath: "wscshop/weapp/authorize.json",
                skipToken: true,
                data: {
                    appId: MINI_APP_ID,
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET,
                    grantType: GRANT_TYPE,
                    code,
                },
            });
            this.token = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${data?.nick_name || data?.nickName || ""} ${maskPhone(data?.mobile)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getPoints("缓存校验");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPoints(label = "积分") {
        const data = await this.request({ apiPath: "wscump/integral/user_points.json" });
        const points = data?.current_points ?? data?.real_points ?? data?.total_points ?? "未知";
        $.log(`账号[${this.index}] ${label}: ${points}积分`);
        return data;
    }

    async getCheckinInfo() {
        const data = await this.request({ apiPath: "wscump/checkin/check-in-info.json" });
        this.checkinId = data?.checkInId || data?.checkinId || data?.check_in_id || "";
        $.log(`账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} ownerKdtId=${data?.activityOwnerKdtId || ""}`);
        return data;
    }

    async getActivityInfo() {
        if (!this.checkinId) return null;
        const data = await this.request({
            apiPath: "wscump/checkin/get_activity_by_yzuid_v2.json",
            query: { checkinId: this.checkinId },
        });
        this.isCheckin = !!data?.isCheckin;
        this.isOpen = data?.isOpen !== false;
        const reward = (data?.dailyRewards || []).map((item) => item?.desc).filter(Boolean).join(", ");
        $.log(`账号[${this.index}] 签到状态: ${this.isCheckin ? "已签" : "未签"} 连续${data?.continuesDay ?? 0}天${reward ? ` 今日奖励${reward}` : ""}`);
        return data;
    }

    async doCheckin() {
        if (!this.checkinId) {
            $.log(`账号[${this.index}] 未获取到签到活动，跳过`);
            return;
        }
        if (this.isCheckin) {
            $.log(`账号[${this.index}] 今日已签到`);
            return;
        }
        if (!this.isOpen) {
            $.log(`账号[${this.index}] 签到活动未开启`);
            return;
        }

        try {
            const data = await this.request({
                apiPath: "wscump/checkin/checkinV2.json",
                query: { checkinId: this.checkinId },
            });
            const award = (data?.list || [])
                .map((item) => item?.infos?.title || item?.infos?.desc || "")
                .filter(Boolean)
                .join(", ");
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${award ? ` ${award}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|参与次数/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (e.code === -1 || e.code === 40010 || e.code === 40009 || /登录|token|access/i.test(message)) this.removeCachedToken();
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
