import { useState } from "react";
import { useStore } from "../store/useStore";
import { answerRun } from "../api/client";
import type { Question } from "../types";

export function QuestionForm() {
  const pending = useStore((s) => s.pendingQuestion);
  const runId = useStore((s) => s.activeRunId);
  const setPending = useStore((s) => s.setPendingQuestion);
  // Each question's answer: string for single-select / free-text, string[] for multiSelect.
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});

  if (!pending) return null;

  const handleSubmit = async () => {
    if (!runId) return;
    const answerList = pending.questions.map(
      (_, i) => answers[i] ?? ""
    );
    setPending(null);
    setAnswers({});
    try {
      await answerRun(runId, answerList);
    } catch {
      // ignore
    }
  };

  const handleDecline = async () => {
    if (!runId) return;
    setPending(null);
    setAnswers({});
    try {
      await answerRun(runId, [], true);
    } catch {
      // ignore
    }
  };

  const toggleMultiOption = (qi: number, label: string) => {
    setAnswers((prev) => {
      const current = prev[qi];
      const arr: string[] = Array.isArray(current) ? [...current] : [];
      const idx = arr.indexOf(label);
      if (idx === -1) {
        arr.push(label);
      } else {
        arr.splice(idx, 1);
      }
      return { ...prev, [qi]: arr };
    });
  };

  return (
    <div className="animate-slide-up border border-blue-200 bg-blue-50 rounded-xl p-4 mx-4 my-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 border border-blue-200 flex items-center justify-center">
          <span className="text-sm">?</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-blue-900 mb-3">
            Dexter 需要您的输入
          </div>
          <div className="space-y-3">
            {pending.questions.map((q: Question, i: number) => {
              const isMulti = q.multiSelect;
              const currentAnswer = answers[i];

              return (
                <div key={i}>
                  {q.header && (
                    <div className="text-xs font-semibold text-blue-800 mb-1">
                      {q.header}
                      {isMulti && (
                        <span className="text-blue-500 font-normal ml-1">
                          （可多选）
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-xs text-blue-700 mb-1.5">
                    {q.question}
                  </div>
                  {q.options && q.options.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {q.options.map((opt, j) => {
                        const isSelected = isMulti
                          ? Array.isArray(currentAnswer) &&
                            currentAnswer.includes(opt.label)
                          : currentAnswer === opt.label;

                        return (
                          <button
                            key={j}
                            title={opt.description}
                            onClick={() =>
                              isMulti
                                ? toggleMultiOption(i, opt.label)
                                : setAnswers((prev) => ({
                                    ...prev,
                                    [i]: opt.label,
                                  }))
                            }
                            className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                              isSelected
                                ? "bg-blue-600 text-white border-blue-600"
                                : "bg-white text-blue-700 border-blue-200 hover:border-blue-400"
                            }`}
                          >
                            {isMulti && (
                              <span className="inline-block w-3 h-3 mr-1 border border-current rounded-sm text-center leading-3 text-[9px] align-middle">
                                {isSelected ? "✓" : ""}
                              </span>
                            )}
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={
                        typeof currentAnswer === "string" ? currentAnswer : ""
                      }
                      onChange={(e) =>
                        setAnswers((prev) => ({ ...prev, [i]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSubmit();
                      }}
                      className="w-full px-3 py-1.5 text-xs border border-blue-200 rounded-lg bg-white text-ink focus:outline-none focus:ring-2 focus:ring-blue-300"
                      placeholder="输入您的回答…"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleSubmit}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              提交
            </button>
            <button
              onClick={handleDecline}
              className="px-3 py-1.5 text-xs font-medium bg-white text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
            >
              跳过
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
