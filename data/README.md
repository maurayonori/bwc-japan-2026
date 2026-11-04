# 制度データ

札幌市・北海道・国の公式ページから起こした「この時期にやること」の項目です。実行時はこのファイルを読むだけで、Claude は公式ページを読みません（[spec.md](../docs/spec.md) §4）。

## 置き場所

| 場所                    | 中身                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `candidates/`           | サブエージェントが公式ページから起こした候補。人が確かめる前のもので、アプリは読まない |
| `candidates/wards.yaml` | 10 区の窓口（区役所・保健センター）のリンクと電話                                      |
| `items/`                | 候補から選び、人が確かめたもの。アプリはここだけを読む（#10 のあとに作る）             |

## 1 項目の形

```yaml
items:
  - id: sapporo-childcare-byouji-teote # 英小文字とハイフン。自治体-領域-名前
    municipality: 札幌市 # 札幌市 / 北海道 / 国
    domain: childcare_registration # procedures（手続きとお金） / vaccines（任意接種） / childcare_registration（預け先の事前登録）
    name: 病児保育の予約システム「テオテ」の登録
    eligibility:
      age_months: { from: 5, to: 72 } # 月齢。上限が無ければ to: null。就学前なら 72 を目安
      work_status: null # null=誰でも。絞るなら [育休中, 復職予定, 働いている, 自営, 働いていない] から配列で
      nursery: null # null=問わず / true=通っている家庭だけ / false=通っていない家庭だけ
      needs_check: false # 入力から判定できない条件があれば true。何が要確認かは notes に書く
    schedule:
      kind: age_start # 下の 5 種類のどれか
      start_months: 5
      recommended_lead_days: 30
    prep_days: 7 # 準備に要る日数。不明なら null
    cost:
      amount: "登録は無料。利用は 1 日 2,000 円" # 自由文。不明なら null
      subsidy: null # 助成があれば自由文
    contacts:
      - ward: null # null=全市共通。区ごとに違えば区名を 1 行ずつ
        name: 札幌市 子ども未来局 子育て支援部
        url: https://kosodate.city.sapporo.jp/...
    source_url: https://kosodate.city.sapporo.jp/... # 公式ページ。必須
    checked_on: 2026-11-04 # 必須。JST
    evidence: "出典の 1〜2 文を原文のまま" # 必須。人が確かめるためのもので、Claude の回答には使わない
    notes: "" # 補足。要確認の中身、関連する項目の id など
```

### 期日の決まり方（`schedule.kind`）

| kind                 | 意味                       | 欄                                                              |
| -------------------- | -------------------------- | --------------------------------------------------------------- |
| `birth_offset`       | 出生から N 日              | `start_days`, `deadline_days`                                   |
| `age_start`          | 月齢で始まる（締切は無い） | `start_months`, `recommended_lead_days`（使う前に済ませる目安） |
| `annual_period`      | 毎年の時期                 | `start: "10-01"`, `end: "12-31"`（月-日）                       |
| `application_window` | 申込の時期（年つき）       | `start: "2026-10-20"`, `deadline: "2026-11-30T17:15"`           |
| `after_previous`     | 前回の完了日から N 日後    | `days_after`, `dose`（何回目か）                                |

## 決まり

- 出典 URL・確認日・根拠の抜粋・期日の決まり方が無い項目はテストで落とす（spec §8）
- 確認日から 90 日を過ぎた項目は「確認が古い」と表示する。隠さない
- 任意接種は「この月齢から受けられる」「費用・助成・窓口」としてだけ書く。「打つべき」「おすすめ」は使わない（[ADR 0003](../docs/adr/0003-first-version-scope-cuts.md)）
- 入力（生年月日・区・親の働き方・保育園の有無）から判定できない条件は `needs_check: true` にして、何が要確認かを `notes` に書く
- 定期接種・健診は入れない（母子モにある。[ADR 0002](../docs/adr/0002-topic-gaps-left-by-existing-apps.md)）
- URL は実際に開いて確かめたものだけを書く。費用は公的機関が示す額だけを書き、医院ごとの掲示は書かない

## 追記（2026-11-04、[ADR 0005](../docs/adr/0005-twelve-month-outlook-as-main-screen.md)）

### 期日の決まり方の 6 種類目

| kind               | 意味                                                 | 欄                                                       |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------- |
| `before_milestone` | 家庭の予定の N 日前（入園予定月の初日・復職予定日）  | `milestone: nursery_start` または `return_to_work`、`days_before` |

### 欄の追加（任意）

- `contacts[].phone`: 電話番号
- `eligibility.age_limit_note`: 制度の本来の上限（例: 「小学 6 年生まで」）。計算には `age_months.to` を使い、表示にはこちらを使う

### 起きうること（`candidates/events.yaml`）

見通しの「起きうること」のレーンに出す、生活のイベントの数字。病気や合併症の確率、ワクチンの効果は書かない（ADR 0003・0005）。出典は公的機関か査読論文だけ。

```yaml
events:
  - id: nursery-sick-absence-age-1           # 英小文字とハイフン
    kind: illness_absence                    # illness_absence（通園できない日数） / parent_leave_days（親が休む日数） / epidemic_season（流行期） / money_in（給付が入る月） / clinic_visits（受診の回数）
    name: 1 歳児は年およそ 12 日、保育園に通えない
    applies_to:
      age_months: { from: 12, to: 23 }       # 月齢。問わなければ null
      nursery: true                          # null=問わず
      months: null                           # 季節性なら [12, 1, 2] のように月の配列
    measure:
      value: 12
      unit: 日/年
      stat: average                          # average / mode / range / share
      basis: "通園児童の休園日数を調査した先行研究"
    source_url: https://...                  # 必須
    checked_on: 2026-11-04                   # 必須
    evidence: "原文 1〜2 文"                   # 必須
    notes: ""
```

## 初版に移すときの決まり（2026-11-04 追記）

- `items/` は候補から作者が選んだもの。選んだ結果と外した理由は docs/worklog/20261104.md と #10 に書く
- 締切日 = 出生日 + `deadline_days`。初日起算の制度（戸籍法の出生届）は 1 を引いて書き、コメントに理由を書く。民法の原則（初日不算入）の制度はそのまま
- 国の制度の id は `national-`、`municipality` は `国`
- `before_milestone` の項目は、入園予定月（または復職予定日）が入力されるまで期日なしで「予定を入れると期日が出る」と表示する
- 領域 `vaccines` の項目は「過ぎた」を赤にしない。流行期（`annual_period`）が終わったら灰色で「今季は終わった」と出す。前回からの間隔（`after_previous`）を過ぎても同じ
- 2 か月ごとの申請のように繰り返す手続き（育児休業給付金）は、初回だけを項目にする
- クラス年齢（0 歳児クラスなど）は 4 月 1 日時点の満年齢で決める。`events` の `age_months` は目安として月齢に写し、計算ではクラス年齢を優先する
- `events.measure.stat` の語彙に `fixed`（定額）と `rate`（人口 10 万対などの率）を足す
