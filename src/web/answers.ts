import type { Question, QuestionAnswer } from '../tools/ask-user-question/types.js';
import type { QuestionAnswerInput } from './types.js';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Map wire answers (string, string[], or a partial/full object) to
 * QuestionAnswer[]. A single string keeps its existing single-select behavior.
 */
export function toQuestionAnswers(
  questions: Question[],
  answers: QuestionAnswerInput[],
): QuestionAnswer[] {
  return questions.map((question, index) => {
    const value = answers[index];
    const base: QuestionAnswer = {
      header: question.header,
      question: question.question,
      selected: [],
    };

    if (typeof value === 'string') {
      return { ...base, selected: [value] };
    }

    if (Array.isArray(value)) {
      return { ...base, selected: value.filter(isString) };
    }

    if (value && typeof value === 'object') {
      const answer: QuestionAnswer = {
        header: typeof value.header === 'string' ? value.header : question.header,
        question: typeof value.question === 'string' ? value.question : question.question,
        selected: Array.isArray(value.selected)
          ? value.selected.filter(isString)
          : typeof value.label === 'string' && value.label
            ? [value.label]
            : [],
      };
      if (typeof value.otherText === 'string') answer.otherText = value.otherText;
      if (typeof value.notes === 'string') answer.notes = value.notes;
      return answer;
    }

    return base;
  });
}
