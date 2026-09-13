import { describe, expect, test } from 'bun:test';
import { toQuestionAnswers } from './answers.js';
import type { Question } from '../tools/ask-user-question/types.js';

const single: Question = {
  question: 'Which market?',
  header: 'Market',
  multiSelect: false,
  options: [],
};

const multi: Question = {
  question: 'Which sectors?',
  header: 'Sectors',
  multiSelect: true,
  options: [],
};

describe('toQuestionAnswers', () => {
  test('maps a single string label like before', () => {
    const answers = toQuestionAnswers([single], ['US']);
    expect(answers).toEqual([
      { header: 'Market', question: 'Which market?', selected: ['US'] },
    ]);
  });

  test('maps a string[] to all selected labels', () => {
    const answers = toQuestionAnswers([multi], [['tech', 'energy']]);
    expect(answers[0].selected).toEqual(['tech', 'energy']);
  });

  test('maps { selected } objects', () => {
    const answers = toQuestionAnswers(
      [multi],
      [{ selected: ['tech', 'health'], notes: 'both' }],
    );
    expect(answers[0]).toMatchObject({
      header: 'Sectors',
      question: 'Which sectors?',
      selected: ['tech', 'health'],
      notes: 'both',
    });
  });

  test('maps { label } objects to a single selection', () => {
    const answers = toQuestionAnswers([single], [{ label: 'EU' }]);
    expect(answers[0].selected).toEqual(['EU']);
  });

  test('preserves a full QuestionAnswer object', () => {
    const answers = toQuestionAnswers(
      [single],
      [
        {
          header: 'Custom',
          question: 'Custom question?',
          selected: ['US'],
          otherText: 'free text',
          notes: 'note',
        },
      ],
    );
    expect(answers[0]).toEqual({
      header: 'Custom',
      question: 'Custom question?',
      selected: ['US'],
      otherText: 'free text',
      notes: 'note',
    });
  });

  test('falls back to an empty selection when the answer is missing', () => {
    const answers = toQuestionAnswers([single, multi], ['US']);
    expect(answers[1]).toEqual({
      header: 'Sectors',
      question: 'Which sectors?',
      selected: [],
    });
  });

  test('drops non-string entries in a string[]', () => {
    const answers = toQuestionAnswers([multi], [['tech', 42 as unknown as string]]);
    expect(answers[0].selected).toEqual(['tech']);
  });
});
