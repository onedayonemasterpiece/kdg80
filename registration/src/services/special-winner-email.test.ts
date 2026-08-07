import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSpecialWinnerEmail } from './email-notifications';

test('winner email is the exact final recipient version without internal approval markers', () => {
  const rendered = renderSpecialWinnerEmail({
    applicationCode: 'AMBER-2026-001',
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

  assert.equal(
    rendered.subject,
    'Вы победили в розыгрыше: Экскурсия на ювелирное производство Калининградского янтарного комбината',
  );
  assert.match(rendered.text, /полное ФИО/i);
  assert.match(rendered.text, /серия и номер/i);
  assert.match(rendered.text, /Фотографию или скан паспорта отправлять не нужно/i);
  assert.match(rendered.text, /10 августа/i);
  assert.match(rendered.html, /amber-combine-jewelry-production\.png/);
  assert.doesNotMatch(rendered.subject, /проект|согласован/iu);
  assert.doesNotMatch(rendered.text, /проект для согласования|это письмо ещё не отправляется/iu);
  assert.doesNotMatch(rendered.html, /проект для согласования|это письмо ещё не отправляется/iu);
  assert.doesNotMatch(rendered.text, /согласие на их обработку и передачу/i);
  assert.doesNotMatch(rendered.text, /код подразделения/i);
});
