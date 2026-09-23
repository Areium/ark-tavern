"""验证：剧情会话开场时，玩家身份角色不应被加载为场景角色。"""
import shutil
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

REPO = Path(__file__).resolve().parents[2]
RUN_ID = uuid.uuid4().hex[:12]
PLOT_ID = f"_test_identity_plot_{RUN_ID}"
IDENTITY = f"_test_identity_{RUN_ID}"
NPC = f"_test_npc_{RUN_ID}"
PLOT_DIR = REPO / "data" / "worldbooks" / "content" / "plots" / PLOT_ID
CHAR_DIR = REPO / "data" / "worldbooks" / "content" / "characters" / IDENTITY
NPC_DIR = REPO / "data" / "worldbooks" / "content" / "characters" / NPC


def main():
    plot_created = identity_created = npc_created = False
    try:
        # 每次运行使用唯一名称，避免与用户的角色或剧情目录冲突。
        PLOT_DIR.mkdir(parents=True, exist_ok=False)
        plot_created = True
        CHAR_DIR.mkdir(parents=True, exist_ok=False)
        identity_created = True
        NPC_DIR.mkdir(parents=True, exist_ok=False)
        npc_created = True

        # 1. 创建临时剧情：initial_characters 包含一个非博士玩家身份
        (PLOT_DIR / "index.md").write_text(
            f"""---
id: {PLOT_ID}
name: 测试身份剧情
initial_location: 测试地点
initial_time: 黎明
initial_characters:
  - {NPC}
  - {IDENTITY}
---
开场设置：这里是测试开场。
## 第1幕：测试开场
玩家与同行者在测试地点相遇。
""",
            encoding="utf-8",
        )

        # 2. 创建本次运行专属的玩家身份角色（非博士）
        (CHAR_DIR / "index.md").write_text(
            f"""---
name: {IDENTITY}
summary: 测试玩家身份
tags: [侦探]
player_identity: true
---
测试玩家身份的背景设定。
""",
            encoding="utf-8",
        )
        (NPC_DIR / "index.md").write_text(
            f"""---
name: {NPC}
summary: 测试场景角色
---
测试场景角色。
""",
            encoding="utf-8",
        )

        # 3. 创建会话，玩家身份为本次运行专属身份
        from app import create_app
        app = create_app()
        client = app.test_client()
        resp = client.post("/api/sessions", json={
            "mode": "story",
            "plot_id": PLOT_ID,
            "identity": IDENTITY,
        })
        assert resp.status_code == 201, resp.get_json()
        sess = resp.get_json()
        session_id = sess["id"]

        print("会话 ID:", session_id)
        print("玩家身份:", sess["player_identity"])
        print("场景角色:", sess["characters"])
        print("环境地点:", sess["environment"]["location"])
        print("环境时间:", sess["environment"]["time"])

        # 断言：玩家身份角色不应出现在场景角色中
        assert IDENTITY not in sess["characters"], \
            f'玩家身份角色被错误加载到场景: {sess["characters"]}'
        assert NPC in sess["characters"]
        assert sess["environment"]["location"] == "测试地点"
        assert sess["environment"]["time"] == "黎明"

        client.delete(f"/api/sessions/{session_id}")
        print("PASS: 玩家身份角色未混入场景，开场环境正确")
    finally:
        if plot_created:
            shutil.rmtree(PLOT_DIR, ignore_errors=True)
        if identity_created:
            shutil.rmtree(CHAR_DIR, ignore_errors=True)
        if npc_created:
            shutil.rmtree(NPC_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
