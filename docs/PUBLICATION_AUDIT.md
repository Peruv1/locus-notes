# Аудит подготовки к публичной публикации

Locus Notes 1.3.0, 4 октября 2026 года. Этот отчёт относится к проверенному локальному набору исходников и собранным Windows-артефактам. Удалённой публикации не было.

## Состав проекта и изменения

Проверены main/preload/renderer, storage, build-конфигурация, metadata, lockfile, tests, assets, docs и локальные generated-каталоги.

Изменены:
- `.gitignore`.
- `package.json` и `package-lock.json`.
- `src/main/index.ts`: navigation restrictions и IPC sender validation.
- `tests/release-ui.mjs`: проверки границ Electron.
- `tests/packaged-smoke.mjs`: отдельный Chromium-профиль и test mode.
- `README.md`, `PROJECT_STATUS.md`, `CHANGELOG.md`, `RELEASE_CHECK.md`.

Добавлены:
- `LICENSE`, `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md`.
- `docs/PUBLICATION_AUDIT.md`, `docs/PUBLISHING.md`.
- `docs/releases/v1.3.0.md`, `docs/releases/v1.3.0-SHA256SUMS.txt`.
- Два скриншота в `docs/screenshots/` с искусственными заметками.

Исполняемые файлы пересобраны; локальные предыдущие exe и снимки до изменений сохранены в исключённых каталогах.

## Приватные данные и история Git

В старых README и PROJECT_STATUS были личное имя пользователя Windows и абсолютные пути. Они убраны из публичных документов. Локальные снимки старых документов и raw build/test/audit output остаются вне публикационного набора.

В корне найден пустой каталог профиля проверки орфографии; после проверки назначения он перенесён в исключённую папку локальной проверки. Пользовательские заметки не удалялись.

В публикационном наборе не обнаружены реальные заметки, backups реальных заметок, базы данных, пользовательский config, cookies, sessions, OAuth credentials, env-файлы, SSH-ключи, signing certificates, dumps или логи. Проверены имена файлов и содержимое текстовых файлов; скриншоты просмотрены отдельно.

Проверка маркеров API/GitHub/AWS tokens, private keys и локальных путей не выявила секретов в публикационном наборе и собственном коде packaged ASAR. Это поиск и осмотр текущих файлов, а не гарантия обнаружения любого произвольного формата секрета.

Email и имена в сторонних лицензиях и metadata lockfile принадлежат upstream-авторам; это публичная атрибуция, которая сохранена. Собственная личная контактная информация не добавлена.

Локального Git-репозитория и commit history до подготовки не было. Поэтому отсутствует локальная история, по которой можно подтвердить или опровергнуть прежние коммиты с секретами. Отдельный временный Git-аудит состава файлов находится в исключённом каталоге; коммитов/remote нет. Если владелец импортирует другую историю, её нужно проверить отдельно: `.gitignore` не удаляет содержимое старых коммитов.

## Исключения и данные

Практический `.gitignore` исключает node_modules, out, release, локальные отчёты и screenshots диагностики, notes/attachments/trash/backups/config в рабочей папке, exports, Electron profiles/caches/crashes, logs, env, ключи/сертификаты, IDE settings и OS/temp files.

Git-проверка подтвердила исключение образцов install exe, build output, audit report, тестового screenshot, config, env и data folders. Публичные source/docs/tests/assets остаются доступными для первого коммита.

По умолчанию все заметки, attachments, Trash, backups и config находятся в системных Документах, отдельно от repository/installation. Storage не переписывался. Для custom `LOCUS_DATA_DIR` рекомендуется отдельная папка вне checkout.

## Документация и лицензии

README, отчёты, руководство участия и текст Release подготовлены на русском по выбору владельца; стандартные лицензии сохранены в оригинале. README отражает действительные возможности: Хранилище — disk usage/cleanup, а не archive.

MIT уже была указана в package metadata. Добавлен стандартный LICENSE с нейтральным существующим holder **Locus Notes**, без выдуманного имени человека.

У runtime-зависимостей обнаружены MIT, ISC, BSD, Python-2.0 и двойная Apache-2.0/MPL-2.0 у DOMPurify. Для DOMPurify выбрана Apache-2.0 option. Тексты и copyright notices собраны для 18 runtime-компонентов, включая Electron. Штатный LICENSES.chromium.html сохраняется в дистрибутиве. Зависимости сохраняют собственные лицензии; MIT применяется к коду приложения.

Metadata: name locus-notes, productName Locus Notes, version 1.3.0, author Locus Notes, license MIT, Node.js >=22.12.0. Настоящий repository URL неизвестен и не выдуман.

## Electron и security maintenance

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Preload предоставляет конкретные операции через contextBridge; сырой ipcRenderer, произвольный shell или Node API не экспортируются.
- IPC invoke handlers теперь проверяют WebContents и main frame отправителя. Постороннее close-notification игнорируется без исключения в event listener.
- `will-navigate` и `will-frame-navigate` запрещают уход с доверенной страницы.
- Новые окна отклоняются; только HTTP(S) URLs передаются системному браузеру.
- Существующие проверки note IDs, Trash filenames, нормализации и границ attachment paths сохранены. HTML Markdown отключён, результат preview проходит через DOMPurify.
- Scheme для вложений и storage architecture не переписывались.

Electron 37.10.3 был уязвим и больше не получал нужных исправлений. Major update оказался необходимым: у [context-isolation bypass](https://github.com/electron/electron/security/advisories/GHSA-h7rp-cf8h-j98x) нет app-side workaround. Выбран Electron **42.11.10**, поддерживаемая исправленная ветка на дату проверки. Это bundled runtime, хотя package относит Electron к devDependencies; его влияние оценивалось отдельно от production npm audit.

Также учтён [custom-protocol advisory](https://github.com/electron/electron/security/advisories/GHSA-v3j7-r9gq-3gjw): добавление `corsEnabled` не использовано как обход проблемы. Исправление обеспечивается обновлённым runtime.

## Зависимости и npm audit

Новых пользовательских зависимостей не добавлено. Прямые зависимости используются текущими import/build/test путями; очевидно случайных или неиспользуемых не обнаружено.

Точечные изменения:
- Electron: 37.10.3 → 42.11.10, необходимый runtime security update.
- DOMPurify: 3.4.15 → 3.4.16, небольшое обновление санитайзера. Приложение не использовало условия IN_PLACE/hook из [advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p).
- http-cache-semantics: 4.2.0 → 4.3.0, patch advisory в инструментах сборки без смены major.

Lockfile также меняется для транзитивного дерева обновлённого Electron. Массовый upgrade остальных прямых зависимостей не выполнялся.

Результат после `npm ci`:
- Production `npm audit --omit=dev`: **0**.
- Полный audit: **2 moderate**, **0 high**, **0 critical** — Vitest и @vitest/mocker, две записи об одной [проблеме redirect mocks](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
- Используется Node `vitest run`. Публичные mocker/interceptor plugins, browser test server и соответствующий WebSocket путь здесь не используются; Vitest отсутствует в shipped runtime.
- Исправление требует нового major Vitest. Некритичный upgrade test infrastructure оставлен отдельной будущей задачей; не подключать эти mocker plugins к доступному извне dev server без обновления.
- Deprecated предупреждения inflight/rimraf/glob/boolean относятся к существующим build tools; не скрыты и не исправлялись массовой заменой toolchain.

Таким образом, оставшиеся audit entries не являются блокером распространения текущего packaged desktop app.

## Проверки, артефакты и публикация

Чистый `npm ci`, 25 tests, TypeScript, production build, оба Windows targets, development и production Electron checks успешно завершены. Подробности и ручные ограничения: [RELEASE_CHECK.md](../RELEASE_CHECK.md).

Релизу нужны два новых exe и рекомендуется файл SHA-256. Binaries остаются на диске, но не входят в Git. ASAR содержит только app output и runtime dependencies; собственные данные и тесты не включены. LICENSE/THIRD_PARTY_NOTICES добавлены в resources.

Не выполнены: OS-level RU/EN switching, фактический мастер установки/portable-wrapper в чистом окружении и открытие вложений внешними приложениями. Тесты проверяли production executable и attachment API в test mode. Сборки unsigned.

Перед нажатием Public проверьте состав первого коммита и выбранную Git identity/email. При импорте иной истории нужен её отдельный аудит. Других обязательных изменений source/docs по результатам этого аудита нет.

Порядок действий: [docs/PUBLISHING.md](PUBLISHING.md). Push, remote repository creation, tag и GitHub Release не выполнялись.
