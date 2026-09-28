#!/usr/bin/env bash
# 统一测试入口：pytest 用例（tests/ + 无外部依赖的 perf_tests）。
#
#   bash scripts/run_tests.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# perf_tests 下无网络/LLM 依赖的战斗与结算用例（嵌入/记忆/前缀缓存类需外部服务，不入网）
PERF_TESTS=(
  perf_tests/test_combat_runtime_v1.py
  perf_tests/test_settlement_v1.py
)

if [ "$#" -ne 0 ]; then
  echo "run_tests.sh 不接受参数"
  exit 2
fi

PY="${PYTHON:-python3}"
failed=0

echo "== pytest: tests/ =="
"$PY" -m pytest tests/ || failed=1
echo "== pytest: perf_tests（无外部依赖子集）=="
"$PY" -m pytest "${PERF_TESTS[@]}" || failed=1

if [ "$failed" = "0" ]; then
  echo "全部通过"
else
  echo "存在失败项"
fi
exit "$failed"
