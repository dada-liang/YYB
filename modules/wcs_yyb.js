const axios = require("axios");

function normalizeServerUrl(value) {
    const url = String(value || "http://yyb-go:8000").trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

function messageOf(envelope, fallback) {
    return String(envelope?.msg || envelope?.message || fallback);
}

class YYBWeChatCodeServer {
    constructor(options = {}) {
        this.serverUrl = normalizeServerUrl(options.url);
        this.appid = String(options.appid || options.app_id || "").trim();
        this.auth = options.auth || "";
    }

    async request(route, ref, { payload, appId = this.appid, requireAppId = true } = {}) {
        const accountRef = String(ref || "").trim();
        if (!accountRef) throw new Error("YYB Go 账号ID或OpenID不能为空");
        if (requireAppId && !appId) throw new Error("YYB Go 小程序 AppID 不能为空");

        const body = { ref: accountRef };
        if (requireAppId) body.app_id = appId;
        if (payload !== undefined) body.payload = payload;

        const response = await axios.post(this.serverUrl + route, body, {
            headers: { "Content-Type": "application/json" },
            timeout: 30000,
            validateStatus: () => true,
        });
        const envelope = response.data || {};
        if (response.status < 200 || response.status >= 300 || Number(envelope.code) !== 0) {
            throw new Error(messageOf(envelope, `YYB Go 请求失败: HTTP ${response.status}`));
        }

        const data = envelope.data || {};
        const result = Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
        response.data = {
            status: true,
            message: messageOf(envelope, "success"),
            data: result || {},
            openid: data.openid || "",
            account: data.account || null,
        };
        return response;
    }

    async getCode(ref) {
        const response = await this.request("/wxapp/getCode", ref);
        if (!response.data?.data?.code) throw new Error("YYB Go 未返回小程序 code");
        return response;
    }

    async getPhoneNumber(ref) {
        return this.request("/wxapp/getPhoneNumber", ref);
    }

    getPhone(ref) {
        return this.getPhoneNumber(ref);
    }

    async getUserInfo(ref) {
        return this.request("/wx/getuserinfo", ref, { requireAppId: false });
    }

    async operateWxData(ref, payload) {
        if (!payload || typeof payload !== "object") {
            throw new Error("调用 YYB Go operateWxData 时必须传入真实 payload");
        }
        return this.request("/wxapp/operateWxData", ref, { payload });
    }

    cloudInit() {
        return Promise.reject(new Error("YYB Go 没有独立 cloudInit 接口，云函数请直接调用 cloudCall 并传入真实 payload"));
    }

    cloudCall(ref, payload) {
        if (!payload || typeof payload !== "object") {
            return Promise.reject(new Error("调用 YYB Go 云函数时必须传入真实 payload"));
        }
        return this.request("/wx/cloud", ref, { payload });
    }

    getEncryptKey(ref, payload) {
        if (!payload || typeof payload !== "object") {
            return Promise.reject(new Error("调用 YYB Go 加密能力时必须传入真实 payload"));
        }
        return this.request("/wx/encryptkey", ref, { payload });
    }
}

module.exports = YYBWeChatCodeServer;
