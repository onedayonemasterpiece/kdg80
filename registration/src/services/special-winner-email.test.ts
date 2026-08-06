import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSpecialWinnerEmail } from './email-notifications';

test('winner email requests only the required Russian passport details and gives a deadline', () => {
  const rendered = renderSpecialWinnerEmail({
    applicationCode: 'TEST-CODE',
    fullName: 'Анна Иванова',
    email: 'anna@example.com',
    event: {
      slug: 'amber-combine-jewelry-excursion',
      title: 'Экскурсия на ювелирное производство Калининградского янтарного комбината',
      venueName: 'Калининградский янтарный комбинат',
    },
    showing: {
      displayLabel: '11 августа 11:00',
      startsAt: '2026-08-11T11:00:00+02:00',
    },
    replyDeadline: '2026-08-10T11:00:00+02:00',
  }, 'Europe/Kaliningrad');

  assert.match(rendered.subject, /Вы победили/);
  assert.match(rendered.text, /полное ФИО/i);
  assert.match(rendered.text, /серию и номер паспорта гражданина Российской Федерации/i);
  assert.match(rendered.text, /Фотографию или скан паспорта отправлять не нужно/i);
  assert.match(rendered.text, /10 августа/i);
  assert.match(rendered.text, /согласие на их обработку и передачу/i);
  assert.match(rendered.html, /amber-combine-jewelry-production\.png/);
  assert.doesNotMatch(rendered.text, /код подразделения/i);
});
