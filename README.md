# Pump.fun Replay Sprint — Paper Bot

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/cervus-snoopy/copper-willow-fox-9q4d/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/cervus-snoopy/copper-willow-fox-9q4d/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot that trades 10 SOL on a 24-hour pump.fun replay.

## Run

Requires Node 22 or later. No dependencies to install and no network access at run time.

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: it reads the harness hello, answers
each batch with one reply line echoing the batch's seq, and stops on done.

## Verify

Grade it locally with the competition kit (from the kit directory, process driver):

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/copper-willow-fox-9q4d --driver process
```

## License

MIT — see [LICENSE](LICENSE).
