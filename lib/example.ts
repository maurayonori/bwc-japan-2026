import { type Workspace } from "./workspace";

// 架空の体験例。AIがその場で生成した回答としては表示しない。
export function exampleWorkspace(): Workspace {
  const first =
    "再来週から2週間、検査のために家を空けます。家ではいつも自分が子どもの朝の支度とごみ出しをしています。家族には一度にいろいろ頼まず、朝のことから渡せるメモを作りたい。";
  const second =
    "朝は7時に起きて、着替えは寝室の白い棚。水筒をかばんの横に置き、8時10分に家を出ます。保険の書類は青いファイルにあるけど、今回の検査入院が対象かまだ確認していない。";
  const third =
    "残しておきたいこともある。今日、一緒にホットケーキを焼いた。ひっくり返せて、ふたりで拍手した。これをそのままメモに残したい。";
  return {
    version: 1,
    mode: "example",
    messages: [
      { id: "example-1", role: "user", text: first },
      { id: "example-2", role: "user", text: second },
      { id: "example-3", role: "user", text: third },
      {
        id: "example-reply",
        role: "assistant",
        text: "朝の引き継ぎメモと、保険会社へ聞く文章を用意しました。今日の出来事は、話した言葉のまま残しています。まず朝のメモを読み返せば、家族に渡す準備ができます。",
      },
    ],
    cards: [
      {
        id: "morning",
        kind: "daily",
        title: "朝の支度を、ひと目で",
        body: "7:00　起きる\n着替え：寝室の白い棚\n水筒：かばんの横に置く\n8:10　家を出る",
        nextStep: "朝の流れに抜けがないか読み返す。",
        uncertainty: "家族の誰が担当できるかは、まだ相談していません。",
        evidence: [
          {
            messageId: "example-2",
            quote:
              "朝は7時に起きて、着替えは寝室の白い棚。水筒をかばんの横に置き、8時10分に家を出ます。",
          },
        ],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "insurance",
        kind: "contact",
        title: "保険会社に、このまま聞く",
        body: "検査のため、再来週から2週間入院する予定です。\n加入している契約で、今回の検査入院は給付の対象になりますか。\n対象の場合、請求に必要な書類、退院前に病院へ依頼しておくもの、請求できる時期を教えてください。\n自分で手続きできない間に家族が請求するための準備があれば、あわせて教えてください。\n\n契約の書類の場所：青いファイル",
        nextStep: "青いファイルで契約先と問い合わせ先を確かめる。",
        uncertainty:
          "給付の対象・必要書類・入金時期は、契約先への確認が必要です。",
        evidence: [
          {
            messageId: "example-1",
            quote: "再来週から2週間、検査のために家を空けます。",
          },
          {
            messageId: "example-2",
            quote:
              "保険の書類は青いファイルにあるけど、今回の検査入院が対象かまだ確認していない。",
          },
        ],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "pancake",
        kind: "memory",
        title: "今日のホットケーキ",
        body: "今日、一緒にホットケーキを焼いた。ひっくり返せて、ふたりで拍手した。",
        nextStep: "この言葉を残しておくか、自分で選ぶ。",
        uncertainty: "",
        evidence: [
          {
            messageId: "example-3",
            quote:
              "今日、一緒にホットケーキを焼いた。ひっくり返せて、ふたりで拍手した。",
          },
        ],
        edited: false,
        done: false,
        included: false,
      },
    ],
  };
}
