'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AISettings {
  id?: string;
  provider: string;
  hasApiKey: boolean;
  maskedApiKey: string | null;
  model: string;
  embeddingModel: string;
  lastVerified: string | null;
  lastError: string | null;
  isActive: boolean;
}

export default function AISettingsPage() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  const [selectedEmbeddingModel, setSelectedEmbeddingModel] = useState('text-embedding-3-small');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function fetchSettings() {
    try {
      const response = await fetch('/api/admin/ai-settings');
      const data = await response.json();
      setSettings(data);
      setSelectedModel(data.model || 'gpt-4o');
      setSelectedEmbeddingModel(data.embeddingModel || 'text-embedding-3-small');
    } catch (error) {
      console.error('Error fetching AI settings:', error);
      setMessage({ type: 'error', text: 'Не удалось загрузить настройки' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSettings();
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const body: Record<string, string> = {
        model: selectedModel,
        embeddingModel: selectedEmbeddingModel,
      };

      if (newApiKey) {
        body.apiKey = newApiKey;
      }

      const response = await fetch('/api/admin/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage({ type: 'success', text: data.message || 'Настройки сохранены' });
        setNewApiKey('');
        await fetchSettings();
      } else {
        setMessage({ type: 'error', text: data.error || 'Ошибка сохранения' });
      }
    } catch (error) {
      console.error('Error saving settings:', error);
      setMessage({ type: 'error', text: 'Не удалось сохранить настройки' });
    } finally {
      setSaving(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setMessage(null);

    try {
      const response = await fetch('/api/admin/ai-settings/verify', {
        method: 'POST',
      });

      const data = await response.json();

      if (response.ok) {
        setMessage({ type: 'success', text: data.message || 'Ключ действителен' });
        await fetchSettings();
      } else {
        setMessage({ type: 'error', text: data.error || 'Ключ недействителен' });
      }
    } catch (error) {
      console.error('Error verifying key:', error);
      setMessage({ type: 'error', text: 'Не удалось проверить ключ' });
    } finally {
      setVerifying(false);
    }
  }

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Настройки интеграций ИИ</h1>

      {/* Status Message */}
      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Провайдер чата</CardTitle>
          <CardDescription>
            Для ответов используется Anthropic при наличии `ANTHROPIC_API_KEY`. Настройка выполняется через переменные окружения.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 space-y-2">
          <p>
            Переменные: <code>AI_PROVIDER</code>, <code>ANTHROPIC_API_KEY</code>, <code>ANTHROPIC_MODEL</code>, <code>ANTHROPIC_MAX_TOKENS</code>.
          </p>
          <p>
            Ключ можно получить на{' '}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              console.anthropic.com
            </a>
          </p>
        </CardContent>
      </Card>

      {/* OpenAI API Settings */}
      <Card>
        <CardHeader>
          <CardTitle>OpenAI (эмбеддинги)</CardTitle>
          <CardDescription>
            Настройки подключения к OpenAI для эмбеддингов и семантического поиска
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Current Key Status */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Текущий API ключ</label>
            <div className="flex items-center gap-4">
              <code className="px-3 py-2 bg-gray-100 rounded text-sm font-mono flex-1">
                {settings?.hasApiKey ? settings.maskedApiKey : 'Не установлен'}
              </code>
              {settings?.hasApiKey && (
                <Badge
                  variant={
                    settings.lastVerified && !settings.lastError ? 'default' : 'secondary'
                  }
                >
                  {settings.lastVerified && !settings.lastError
                    ? 'Действителен'
                    : settings.lastError
                    ? 'Ошибка'
                    : 'Не проверен'}
                </Badge>
              )}
            </div>
            {settings?.lastVerified && (
              <p className="text-xs text-gray-500">
                Последняя проверка: {new Date(settings.lastVerified).toLocaleString('ru-RU')}
              </p>
            )}
            {settings?.lastError && (
              <p className="text-xs text-red-600">Ошибка: {settings.lastError}</p>
            )}
          </div>

          {/* New API Key Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Новый API ключ</label>
            <Input
              type="password"
              placeholder="sk-..."
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
            />
            <p className="text-xs text-gray-500">
              Оставьте пустым, чтобы сохранить текущий ключ
            </p>
          </div>

          {/* Models */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Модель для чата</label>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt-4o">GPT-4o (рекомендуется)</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini (быстрее)</SelectItem>
                  <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo (дешевле)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Модель для эмбеддингов</label>
              <Select value={selectedEmbeddingModel} onValueChange={setSelectedEmbeddingModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text-embedding-3-small">
                    text-embedding-3-small (рекомендуется)
                  </SelectItem>
                  <SelectItem value="text-embedding-3-large">
                    text-embedding-3-large (точнее)
                  </SelectItem>
                  <SelectItem value="text-embedding-ada-002">
                    text-embedding-ada-002 (устаревшая)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-4 pt-4 border-t">
            <Button onClick={handleVerify} variant="outline" disabled={verifying || !settings?.hasApiKey}>
              {verifying ? 'Проверка...' : 'Проверить ключ'}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Usage Info */}
      <Card>
        <CardHeader>
          <CardTitle>Информация об использовании</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 space-y-2">
          <p>
            API ключ используется для:
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>Создания эмбеддингов для поиска</li>
            <li>Чат-операций только если выбран провайдер OpenAI</li>
          </ul>
          <p className="mt-4 text-xs text-gray-500">
            Ключ хранится в зашифрованном виде. Для получения API ключа перейдите на{' '}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              platform.openai.com
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
