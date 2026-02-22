# Codex Agent 移行設計

## 背景

現在の `AgenticEngine` はLLMを「構造化JSON → 構造化JSON」の関数的に使っている。
engine.ts 側に900行超のプランナーロジック（シグナル計算、ルールベース判断、LLM出力サニタイズ）が存在し、LLMの判断力を十分に活かせていない。

## 方針

判断の主体を engine.ts のルールロジックから **Codex エージェント** に移す。
Codex はシェル・ファイルシステムにアクセスできるため、自律的に価格取得・分析・売買判断・実行が可能。

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│ Engine (残す部分)                              │
│  - スキャンループ (1-3分間隔)                    │
│  - 損切りチェック (即座に実行、Codex不要)          │
│  - 金額上限・ポジション上限の強制                  │
│  - kill switch                               │
│  - 状態永続化 (state.json)                     │
│  - applyExecutionResult()                    │
└──────────────┬──────────────────────────────┘
               │ codex exec
               v
┌─────────────────────────────────────────────┐
│ Codex Agent (新規)                            │
│  - 自分で Jupiter API を叩いて価格を取得          │
│  - 自分で市場を分析・推論（多段推論が可能）          │
│  - 売買判断を下す                               │
│  - wallet-mcp 経由で実行                       │
│  - 結果を state に書き戻す                      │
└─────────────────────────────────────────────┘
```

## 削除されるもの

- `planWithRules()` — ルールベースプランナー
- `sanitizeLlmPlan()` — LLM出力のサニタイズ
- `buildLlmPromptContext()` — LLM用コンテキスト構築
- `signal.ts` — モメンタムシグナル計算
- `requestLlmPlan()` / `requestLlmPlanViaCodexExec()` — 現在のLLM呼び出し

## 残すもの

- **損切り**: 機械的判断は Engine 側にハードコード。遅延が許されない処理。
- **安全装置**: kill switch、max trade size、max positions、cooldown gap
- **状態管理**: `applyExecutionResult()`、`loadAgenticState()`、`saveAgenticState()`
- **実行層**: wallet-mcp（変更なし）

## Codex への指示

正式なツール定義は不要。system prompt で最低限の情報を渡す:

- Jupiter Price API の URL
- wallet-mcp の起動方法と JSON-RPC インターフェース
- state.json のパスとスキーマ
- 取引対象トークン一覧
- 制約条件（金額上限、ポジション上限）

Codex は必要に応じてプロジェクトのコードを読んで詳細を把握する。

## レイテンシ

| | 現状 | Codex agent |
|---|---|---|
| 1サイクル | ~2-5秒 | ~30秒-2分 |
| 判断間隔 | 20秒 | 1-3分 |

現在の戦略（ホールド数時間、利確15%、損切り-10%）では問題なし。
損切りのみ Engine 側で即座に実行するため、暴落時の遅延リスクも解消。

## 移行ステップ

1. Engine から損切りロジックを独立させる（Codex不要で即実行）
2. `codex exec` の呼び出しを書き換え、system prompt でエージェント的に動かす
3. `planWithRules()`, `sanitizeLlmPlan()`, `signal.ts` を削除
4. スキャンインターバルを調整（20s → 60-120s）
5. paper trade で検証
