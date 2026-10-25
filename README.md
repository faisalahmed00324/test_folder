# Games

Each game lives in its own folder. Carrom is available at `/Carrom/carrom.html`;
the root URL currently opens Carrom as the default game.

To add another game, place its browser assets in a folder and add its published
asset paths to the `ASSETS` allowlist in `server.js`. The production build copies
only those listed files, preserving their folder paths. Keep game-specific tests
and documentation alongside the game.

Run the local server with `npm start`. Run the shared checks with `npm run typecheck`
and `npm test`.