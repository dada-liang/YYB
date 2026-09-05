#by:哆啦A梦
#入口:http://mx.qrurl.net/h5/wxa/link?sid=26407uif5Oq
#账号来源: 环境变量 YYB_SERVER（格式: 服务器地址@账号ID或OpenID，多账号换行或 & 分割）
#new Env("BREO")
#cron 8 9,10,11 * * *


import requests
import json
import os
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MINI_APP_ID = "wx61457400e4212cec"
TOKEN_CACHE_PATH = Path(__file__).with_name("BREO_token_cache.json")
LOGIN_BASE = "https://breoplus.breo.cn/app/minic"
APP_BASE = "https://breoplus.breo.cn/breo-app"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"

session = requests.Session()

def parse_yyb_account(raw):
    text = str(raw or "").strip()
    left, _, remark = text.partition("#")
    server, at, ref = left.rpartition("@")
    if not at or not server.strip() or not ref.strip():
        raise ValueError(f"YYB_SERVER 格式无效(应为 服务器地址@账号ID或OpenID): {text}")
    server = server.strip().rstrip("/")
    if not server.lower().startswith(("http://", "https://")):
        server = "http://" + server
    return {"server": server, "ref": ref.strip(), "remark": remark.strip()}

def account_cache_key(account):
    if isinstance(account, dict):
        return f"{account.get('server', '').lower()}@{account.get('ref', '')}"
    return str(account)

def extract_yyb_code(payload):
    result = payload.get("result") if isinstance(payload, dict) else None
    data = payload.get("data") if isinstance(payload, dict) else None
    nested = data.get("result") if isinstance(data, dict) else None
    candidates = [nested, result]
    candidates.extend([item.get("raw") for item in (result, nested) if isinstance(item, dict)])
    for item in candidates:
        if isinstance(item, str):
            try:
                item = json.loads(item)
            except (TypeError, ValueError):
                continue
        if isinstance(item, dict) and isinstance(item.get("code"), str) and item["code"]:
            return item["code"]
    return ""

def read_token_cache():
    try:
        if not TOKEN_CACHE_PATH.exists():
            return {}
        return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"⚠️ 写入token缓存失败: {e}")

def mask_token(token):
    if not token:
        return ""
    return f"{token[:6]}***{token[-6:]}"

def is_success(result):
    return result.get("success") is True or str(result.get("code")) in ("0000", "200", "200.0")

def is_token_error(message):
    text = str(message)
    return any(key in text for key in ["40101", "40102", "token", "登录", "授权", "过期", "失效"])

def app_headers(token=None):
    headers = {
        "User-Agent": DEFAULT_UA,
        "content-Type": "application/json",
        "Content-Type": "application/json",
        "deviceInfo": "{}",
        "Referer": "https://servicewechat.com/wx61457400e4212cec/390/page-frame.html",
    }
    if token:
        headers["token"] = token
    return headers

def breo_task_headers(token):
    return {
        "token": token,
        "device-type": "Xiaomi",
        "device-version": "10",
        "channel": "Breo",
        "version_code": "30201",
        "version": "3.2.1",
        "encrypt": "1",
        "Content-Type": "application/json; charset=UTF-8",
        "Referer": "https://servicewechat.com/wx61457400e4212cec/390/page-frame.html",
        "User-Agent": DEFAULT_UA,
    }

def get_wx_code(account_id):
    resp = session.post(
        f"{account_id['server']}/wxapp/getCode",
        json={"ref": account_id["ref"], "app_id": MINI_APP_ID},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict) or data.get("code") != 0:
        raise RuntimeError(f"YYB取 code 失败: {data.get('msg') if isinstance(data, dict) else data}")
    code = extract_yyb_code(data)
    if not code:
        raise RuntimeError(f"YYB未返回code: {data}")
    return code

def login_with_code(account_id):
    code = get_wx_code(account_id)
    login_resp = session.get(
        f"{LOGIN_BASE}/login/{code}",
        headers=app_headers(),
        timeout=30,
    )
    login_resp.raise_for_status()
    login_data = login_resp.json()
    if str(login_data.get("code")) != "200" or not login_data.get("data"):
        raise RuntimeError(f"code登录失败: {login_data}")
    user_info = login_data["data"]
    uid = user_info.get("uid")
    open_id = user_info.get("openId")
    union_id = user_info.get("unionId")
    if not uid:
        raise RuntimeError(f"登录响应缺少uid: {login_data}")

    token_resp = session.post(
        f"{APP_BASE}/customer/loginByUid",
        json={"uid": uid, "openId": open_id, "unionId": union_id},
        headers=app_headers(),
        timeout=30,
    )
    token_resp.raise_for_status()
    token_data = token_resp.json()
    if not is_success(token_data) or not (token_data.get("result") or {}).get("token"):
        raise RuntimeError(f"业务token登录失败: {token_data}")
    return {
        "token": token_data["result"]["token"],
        "uid": uid,
        "openId": open_id,
        "unionId": union_id,
        "userInfo": user_info,
        "customer": token_data.get("result", {}),
        "updatedAt": int(time.time()),
    }

def get_cached_token(account_id):
    return read_token_cache().get(account_cache_key(account_id))

def save_cached_token(account_id, auth_info):
    cache = read_token_cache()
    cache[account_cache_key(account_id)] = auth_info
    write_token_cache(cache)

def remove_cached_token(account_id):
    cache = read_token_cache()
    key = account_cache_key(account_id)
    if key in cache:
        del cache[key]
        write_token_cache(cache)

def validate_token(token):
    try:
        resp = session.post(
            f"{APP_BASE}/getUserLevelInfoByUid",
            headers=app_headers(token),
            timeout=15,
        )
        if resp.status_code != 200:
            return False
        data = resp.json()
        if is_success(data):
            return True
        return not is_token_error(data)
    except Exception:
        return False

def get_token_for_account(account_id, index):
    cached = get_cached_token(account_id)
    if cached and cached.get("token"):
        print(f"账号 {index} 使用缓存token: {mask_token(cached['token'])}")
        if validate_token(cached["token"]):
            return cached["token"]
        print(f"账号 {index} 缓存token失效，重新登录")
        remove_cached_token(account_id)

    auth_info = login_with_code(account_id)
    save_cached_token(account_id, auth_info)
    user_info = auth_info.get("userInfo") or {}
    print(f"账号 {index} code登录成功: {user_info.get('nickname') or user_info.get('telephone') or auth_info.get('uid')}")
    return auth_info["token"]

def get_random_one_word():
    try:
        response = requests.get("https://uapis.cn/api/say")
        if response.status_code == 200:
            return response.text.strip()
        else:
            return "无法获取一言"
    except Exception as e:
        print(f"获取一言时出错: {e}")
        return "无法获取一言"

def get_proclamation():
    primary_url = "https://github.com/3288588344/toulu/raw/refs/heads/main/tl.txt"
    backup_url = "https://tfapi.cn/TL/tl.json"
    try:
        response = requests.get(primary_url, timeout=10)
        if response.status_code == 200:
            print("\n" + "=" * 50)
            print("📢 公告信息")
            print("=" * 35)
            print(response.text)
            print("=" * 35 + "\n")
            print("公告获取成功，开始执行任务...\n")
            return
    except requests.exceptions.RequestException as e:
        print(f"获取公告时发生错误: {e}, 尝试备用链接...")

    try:
        response = requests.get(backup_url, timeout=10)
        if response.status_code == 200:
            print("\n" + "=" * 50)
            print("📢 公告信息")
            print("=" * 35)
            print(response.text)
            print("=" * 35 + "\n")
            print("公告获取成功，开始执行任务...\n")
        else:
            print(f"⚠️ 获取公告失败，状态码: {response.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"⚠️ 获取公告时发生错误: {e}, 可能是网络问题或链接无效。")

def post_to_breo(token, content, title):
    url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/releasePost"
    headers = breo_task_headers(token)
    data = {
        "anonymoused": 1,
        "content": content,
        "expressText": "",
        "images": [],
        "subTitle": "",
        "title": title,
        "topicText": ""
    }
    try:
        response = requests.post(url, headers=headers, data=json.dumps(data))
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 发帖成功！")
                print(f"帖子 ID: {result['result']['id']}")
                print(f"帖子标题: {result['result']['title']}")
                return result["result"]["id"]
            else:
                print(f"❌ 发帖失败，错误信息：{result.get('message', '未知错误')}")
                return None
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
            return None
    except Exception as e:
        print(f"❌ 请求错误: {e}")
        return None

def collect_post(token, post_id):
    url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/collect"
    headers = breo_task_headers(token)
    data = {
        "postId": post_id
    }
    try:
        response = requests.post(url, headers=headers, data=json.dumps(data))
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 收藏成功！")
                reward = result.get("result") or {}
                print(f"获得点数: {reward.get('point', 0)}")
                print(f"成长值: {reward.get('grow', 0)}")
            else:
                print(f"❌ 收藏失败，错误信息：{result.get('message', '未知错误')}")
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
    except Exception as e:
        print(f"❌ 请求错误: {e}")

def comment_post(token, post_id):
    for _ in range(2):  # 评论2次
        comment_content = get_random_one_word()  # 使用随机一言作为评论内容
        url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/comment"
        headers = breo_task_headers(token)
        data = {
            "anonymoused": 0,
            "commentText": comment_content,
            "postId": post_id
        }
        try:
            response = requests.post(url, headers=headers, data=json.dumps(data))
            if response.status_code == 200:
                result = response.json()
                if result.get("success", False):
                    print("✅ 评论成功！")
                    reward = result.get("result") or {}
                    root = reward.get("rootOutVO") or {}
                    print(f"评论内容: {root.get('commentText', comment_content)}")
                    print(f"获得点数: {reward.get('point', 0)}")
                    print(f"成长值: {reward.get('grow', 0)}")
                else:
                    print(f"❌ 评论失败，错误信息：{result.get('message', '未知错误')}")
            else:
                print(f"❌ 请求失败，状态码：{response.status_code}")
        except Exception as e:
            print(f"❌ 请求错误: {e}")
        time.sleep(1)  # 避免频繁请求

def browse_mall(token):
    url = "https://breoplus.breo.cn/breo-app/user/po-task-info/mall"
    headers = breo_task_headers(token)
    try:
        response = requests.post(url, headers=headers)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 浏览商城成功！")
                reward = result.get("result") or {}
                print(f"获得点数: {reward.get('point', 0)}")
                print(f"成长值: {reward.get('grow', 0)}")
            else:
                print(f"❌ 浏览商城失败，错误信息：{result.get('message', '未知错误')}")
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
    except Exception as e:
        print(f"❌ 请求错误: {e}")

def punch_in(token):
    url = "https://breoplus.breo.cn/breo-app/user/po-task-info/punch"
    headers = breo_task_headers(token)
    try:
        response = requests.post(url, headers=headers)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 签到成功！")
                reward = result.get("result") or {}
                print(f"获得点数: {reward.get('point', 0)}")
                print(f"成长值: {reward.get('grow', 0)}")
            else:
                print(f"❌ 签到失败，错误信息：{result.get('message', '未知错误')}")
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
    except Exception as e:
        print(f"❌ 请求错误: {e}")

if __name__ == "__main__":
    # 获取公告
    #get_proclamation()

    # 从环境变量 YYB_SERVER 读取账号（服务器地址@账号ID或OpenID）
    raw = os.getenv("YYB_SERVER", "")
    accounts = []
    for item in raw.replace("&", "\n").splitlines():
        if not item.strip():
            continue
        try:
            accounts.append(parse_yyb_account(item))
        except ValueError as e:
            print(f"❌ {e}")
    if not accounts and os.getenv("BREO", "").strip():
        print("❌ 检测到旧变量 BREO：本脚本账号来源已改为环境变量 YYB_SERVER（格式：服务器地址@账号ID或OpenID），请迁移配置。")

    if not accounts:
        print("❌ 未检测到 账号信息，退出脚本。")
    else:
        skip_community = os.getenv("BREO_SKIP_COMMUNITY", "").lower() in ("1", "true", "yes")
        print("=============== 开始执行任务 ===============")
        for i, account in enumerate(accounts, 1):
            print(f"\n-------------- 账号 {i} 开始 --------------")
            try:
                token = get_token_for_account(account, i)
            except Exception as e:
                print(f"❌ 账号 {i} 登录失败: {e}")
                continue

            print("🚀 正在签到...")
            punch_in(token)

            if skip_community:
                print("\n📝 已跳过发帖/收藏/评论任务")
            else:
                print("\n📝 正在发布帖子...")
                post_id = post_to_breo(token, "这是一个自动发布的帖子", "自动化测试")
                if post_id:
                    print("\n⭐ 正在收藏帖子...")
                    collect_post(token, post_id)

                    print("\n💬 正在评论帖子...")
                    comment_post(token, post_id)
                else:
                    print("❌ 发帖失败，跳过后续操作。")

            print("\n🛒 正在浏览商城...")
            browse_mall(token)

            print(f"-------------- 账号 {i} 结束 --------------")

        print("\n=============== 所有任务执行完毕 ===============")
