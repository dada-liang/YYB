const fs = require("fs");
const path = require("path");

function textOf(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (value && typeof value === "object") {
        try { return JSON.stringify(value); } catch { return "[Complex Object]"; }
    }
    return String(value);
}

function normalizeServer(server) {
    return String(server || "").trim().replace(/\/+$/, "").toLowerCase();
}

function yybCacheKey(server, ref) {
    return `${normalizeServer(server)}@${String(ref || "").trim()}`;
}

function findNotifier() {
    const candidates = [
        path.join(process.cwd(), "sendNotify.js"),
        path.join(process.cwd(), "tools", "sendNotify.js"),
        path.join(__dirname, "sendNotify.js"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return "";
}

class Env {
    constructor(name) {
        this.name = name;
        this.userIdx = 1;
        this.userList = [];
        this.userCount = 0;
        this.notifyStr = [];
        this.startTime = Date.now();
        this.log(`🔔${name},开始!`);
    }

    checkEnv(name = "YYB_SERVER") {
        const value = String(process.env[name] || "");
        this.userList = value.split(/\r?\n|&/).map((item) => item.trim()).filter(Boolean);
        this.userCount = this.userList.length;
        this.log(`共找到${this.userCount}个账号`);
    }

    log(...values) {
        const message = values.map(textOf).join(" ");
        const now = new Date();
        const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((value) => String(value).padStart(2, "0")).join(":");
        this.notifyStr.push(`[${time}] ${message}`);
        console.log(...values);
    }

    wait(min, max = min) {
        const delay = Math.round(min + Math.random() * Math.max(0, max - min));
        return new Promise((resolve) => setTimeout(resolve, delay));
    }

    uuid() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
            const random = Math.floor(Math.random() * 16);
            return (char === "x" ? random : (random & 3) | 8).toString(16);
        });
    }

    async done() {
        const content = this.notifyStr.join("\n");
        const systemNotify = globalThis.QLAPI?.systemNotify;
        if (typeof systemNotify === "function") {
            try {
                const result = await systemNotify({ title: this.name, content });
                if (Number(result?.code) === 200) {
                    console.log("青龙系统通知发送成功");
                } else {
                    console.error(`青龙系统通知发送失败: ${result?.message || JSON.stringify(result)}`);
                }
            } catch (error) {
                console.error(`青龙系统通知发送失败: ${error.message || error}`);
            }
            const seconds = ((Date.now() - this.startTime) / 1000).toFixed(2);
            console.log(`🔔${this.name},结束!🕛 ${seconds}秒`);
            return;
        }

        const notifierPath = findNotifier();
        if (notifierPath) {
            try {
                const { sendNotify } = require(notifierPath);
                await sendNotify(this.name, content);
            } catch (error) {
                console.error(`发送通知失败: ${error.message || error}`);
            }
        } else {
            console.error("发送通知失败: 未找到 sendNotify.js");
        }
        const seconds = ((Date.now() - this.startTime) / 1000).toFixed(2);
        console.log(`🔔${this.name},结束!🕛 ${seconds}秒`);
    }
}

module.exports = { Env, yybCacheKey };
