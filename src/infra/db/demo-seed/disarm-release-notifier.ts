/**
 * Switches off the release notifier, before `AppModule` is loaded.
 *
 * **A file of its own because the timing cannot be expressed any other way.**
 * `ConfigModule.forRoot()` runs when `AppModule`'s `@Module` decorator is evaluated —
 * at *import* time, before the first statement of any function in this directory — and
 * it snapshots the merged environment there and then. So an assignment inside `main()`
 * is too late, and an assignment at the top of `main.ts` is too late as well: a
 * compiler hoists every `import` above the statements around them. Only a module
 * imported ahead of `AppModule` runs early enough.
 *
 * `process.env` beats the `.env` file in that merge (`config.module.js` spreads it
 * last), so writing an empty value here is enough to make `ReleaseNotifierService` log
 * "release notices are off" and return.
 *
 * **Why bother.** Booting the application boots everything in it, and one of those
 * things polls GitHub and posts a new APK to the owner's Telegram chat. Seeding a
 * database is not a release. A tool whose side effect is a message to somebody's phone
 * is a tool that gets run once and then avoided.
 *
 * `main.ts` asserts after boot that this actually took effect, because an import that
 * has to come first is exactly the kind of thing a tidy-up reorders.
 */
process.env.RELEASE_CHAT_ID = '';
