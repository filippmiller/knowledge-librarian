/**
 * Вердикт оператора об удержанном черновике. callback_data: `hv:<вердикт>:<id>`.
 *
 * Это замыкание петли: контроль удержал ответ, человек разобрал вопрос и одним
 * нажатием говорит, был ли черновик верен. Без этого частота срабатывания
 * контроля не отличает верную тревогу от ложной, и решение «ослабить контроль»
 * или «добавить контроль» принимается вслепую.
 *
 * Спрашивается именно здесь и одной кнопкой: оператор уже читает черновик, это
 * единственный момент, когда его вывод стоит дёшево. Отдельная страница для
 * разметки не будет открыта никогда.
 */
import { sendMessage } from './telegram-api';
import { HELD_VERDICT_LABELS, isHeldVerdict, setHeldVerdict } from '@/lib/ai/held-answers';
import type { TelegramUserInfo } from './access-control';

export async function handleHeldVerdictCallback(
  chatId: number,
  telegramId: string,
  payload: string,
  user: TelegramUserInfo
): Promise<void> {
  const [verdict, id] = payload.split(':');

  if (!isHeldVerdict(verdict) || !id) {
    console.warn('[held-verdict] непонятный payload:', payload);
    return;
  }

  // Вердикт — это разметка для замера, а не действие над знанием, поэтому
  // достаточно доступа к боту. Но автор фиксируется: расхождение двух операторов
  // по одному черновику само по себе полезный сигнал.
  const author = user.username ? `@${user.username}` : telegramId;
  const saved = await setHeldVerdict(id, verdict, author);

  await sendMessage(
    chatId,
    saved
      ? `Записал: ${HELD_VERDICT_LABELS[verdict]}.`
      : 'Не удалось записать вердикт — запись об удержании не найдена.'
  );
}
