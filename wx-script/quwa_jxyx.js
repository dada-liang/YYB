/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 趣蛙/匠心优选 登录/查询/签到任务
cron: 10 14 * * *
------------------------------------------
变量名：quwa_jxyx
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行
依赖变量：YYB_SERVER（服务器地址@账号ID或OpenID）
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("趣蛙/匠心优选");
const axios = require("axios");
const crypto = require("crypto");
const WeChatServer = require("./wcs.js");

const CK_NAME = "quwa_jxyx";
const APP = { name: "趣蛙/匠心优选", appid: "wxddaa0832e6acc5f1" };
const DEFAULT_OPENID = process.env.wx_openid || "";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function short(value, max = 220) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex");
}

function sha1(text) {
    return crypto.createHash("sha1").update(String(text)).digest("hex");
}

async function request(options) {
    const res = await axios.request({
        timeout: 20000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            ...(options.headers || {}),
        },
    });
    return { status: res.status, headers: res.headers || {}, data: res.data };
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

class Quwa {
    constructor(openid) {
        this.yyb = parseAccount(openid);
        this.openid = this.yyb ? this.yyb.ref : String(openid || "").trim();
        this.wechat = this.yyb ? new WeChatServer({ url: this.yyb.server, appid: APP.appid, auth: process.env.wx_auth || "" }) : null;
        this.base = "https://api.quwayouxuan.com";
        this.token = "";
        this.userID = "";
        this.globalData = {
            current_time: Date.now(),
            os: "miniProgram",
            deviceabout: "miniProgram",
            version: "1.3.01",
            miniprogram_os: "",
        };
    }

    signKey(data) {
        const sorted = {};
        Object.keys(data || {})
            .sort()
            .forEach((key) => {
                sorted[key] = data[key];
            });
        const text = Object.keys(sorted)
            .map((key) => `${key}=${sorted[key]}`)
            .join("");
        const encoded = encodeURIComponent(`${text}superjing`.replace(/\s+/g, ""))
            .replace(/%20/gi, "")
            .replace(/(!)|(')|(\()|(\))|(\~)|(\*)/gi, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        return sha1(encoded);
    }

    async api(path, data = {}) {
        const body = {
            ...this.globalData,
            current_time: Date.now(),
            ...(this.token ? { token: this.token } : {}),
            ...data,
        };
        body.key = this.signKey(body);
        const res = await request({
            method: "POST",
            url: `${this.base}${path}`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            data: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString(),
        });
        return res.data;
    }

    async login() {
        if (!this.wechat) throw new Error("YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID），无法获取code");
        const { data: codeRes } = await this.wechat.getCode(this.yyb.ref);
        const code = codeRes.data.code;
        const login = await this.api("/mini_program/get_openid.do", { code });
        if (String(login?.code) !== "1" || !login?.data?.token) throw new Error(`登录失败: ${short(login)}`);
        this.token = login.data.token;
        const check = await this.api("/consumer/consumer/checkOpenid.do", { invitation: "" });
        const data = check?.data || {};
        this.userID = data.userID || data.userid || data.id || login.data.userID || "";
        return `openid=${login.data.openid || ""} userID=${this.userID || "未知"}`;
    }

    async query() {
        const center = await this.api("/dmluser/center.do", {});
        const info = center?.data?.user_info || center?.data?.userinfo || center?.data || {};
        const score = info.integral || info.score || info.points || info.balance || info.user_integral;
        const name = info.nickname || info.nickName || info.mobile || info.username || "";
        return `用户=${name || "未知"} 积分=${score ?? "未知"} 返回=${short(center, 180)}`;
    }

    async sign() {
        const tasks = await this.api("/task/task/taskList.do", { source: 4 });
        const day = tasks?.data?.tasklist?.day || [];
        const task =
            day.find((item) => /签到|每日|趣赚分|积分/.test(`${item.name || item.title || ""}`) && String(item.status || item.is_finish || "") !== "1") ||
            day.find((item) => String(item.type) === "1" && String(item.status || item.is_finish || "") !== "1");
        if (!task) return `未找到可完成签到任务: taskList=${short(tasks, 220)}`;
        if (task.skiprule && task.skiprule !== "") return `任务需要跳转/广告，跳过: ${short(task)}`;
        const requestId = md5(`${this.userID}aopijkks${Date.now()}`);
        const sign = await this.api("/task/task/taskSuccrss.do", {
            taskid: task.id,
            subtask_id: task.subtask_id,
            request_id: requestId,
        });
        return `任务=${task.name || task.title || task.id} 返回=${short(sign)}`;
    }
}

async function runAccount(openid, index) {
    $.log(`\n========== ${APP.name} 账号[${index}] ${openid} ==========`);
    const runner = new Quwa(openid);
    try {
        $.log(`登录：${await runner.login()}`);
        $.log(`查询：${await runner.query()}`);
        $.log(`签到：${await runner.sign()}`);
    } catch (e) {
        $.log(`执行失败：${e.message || e}`);
    }
}

(async () => {
    $.checkEnv("YYB_SERVER");
    const manualList = (process.env[CK_NAME] || process.env.wx_openid || "")
        .split(/\r?\n|&/)
        .map((x) => x.trim())
        .filter(Boolean);
    for (const item of manualList) if (!$.userList.includes(item)) $.userList.push(item);
    const accounts = $.userList;
    if (!accounts.length) {
        $.log(`未找到变量 YYB_SERVER 或 ${CK_NAME}`);
        await $.done();
        return;
    }
    $.log(`共找到${accounts.length}个账号`);
    for (let i = 0; i < accounts.length; i++) {
        await runAccount(accounts[i], i + 1);
        await $.wait(800);
    }
    await $.done();
})().catch(async (e) => {
    $.log(`脚本异常：${e.stack || e.message || e}`);
    await $.done();
});
