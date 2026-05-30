// Handles inline-button clicks on knowledge-gap draft approval messages.
// callback_data shape: "kg:approve:<aiQuestionId>" or "kg:reject:<aiQuestionId>"
// (the "kg:" prefix is stripped by the router before this is called).

import { sendMessage } from './telegram-api';
import { isSuperAdmin } from './access-control';
import type { TelegramUserInfo } from './access-control';
import { approveKnowledgeGap, rejectKnowledgeGap } from '@/lib/ai/knowledge-feedback';

export async function handleKnowledgeGapCallback(
  chatId: number,
  telegramId: string,
  data: string,
  user: TelegramUserInfo
): Promise<void> {
  // Only super-admins may write to the knowledge base.
  if (!isSuperAdmin(user.role)) {
    await sendMessage(chatId, 'Только суперадминистратор может утверждать черновики.');
    return;
  }

  const sep = data.indexOf(':');
  const action = sep === -1 ? data : data.slice(0, sep);
  const id = sep === -1 ? '' : data.slice(sep + 1);
  if (!id) {
    await sendMessage(chatId, 'Не удалось определить черновик.');
    return;
  }

  try {
    if (action === 'approve') {
      const { qaPairId } = await approveKnowledgeGap(id, { approvedBy: telegramId });
      await sendMessage(chatId, `✅ Сохранено в базу знаний (пара ${qaPairId.slice(0, 8)}…). Теперь этот вопрос отвечается из базы.`);
    } else if (action === 'reject') {
      await rejectKnowledgeGap(id);
      await sendMessage(chatId, '✖️ Черновик отклонён.');
    } else {
      await sendMessage(chatId, `Неизвестное действие: ${action}`);
    }
  } catch (e) {
    await sendMessage(chatId, `Не удалось обработать: ${(e as Error).message}`);
  }
}
