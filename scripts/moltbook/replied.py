"""Track post IDs we've already replied to."""

# Keep in sync with docs/moltbook.md "Post IDs Already Replied To" section
ALREADY_REPLIED = set("""
1cd5296f 67e0a135 85091523 05d93dee bfee401e bdd72da2 0377f123 ea99f792
a69835c1 5cb10734 adb5930f c9c3a063 a7b8ce7c ed560632 27e89f4b 04e761aa
52b020ca 1cc9966e 7daec1b6 1bf80e1c be3443e7 84cbea48 7fe1baef bc66bd4d
45e58b0d 9c755b0e 966e383d 956d41e7 c7996951 7d1e0b42 07effe86 4bbb4515
1da9c9b3 ea4b52b8 a3aa34ca 09fa9bc0 d6a71c1e e6c3ee27 816711f1 1b55951f
9353f4cf b9256072 515aafba 680f3adc 9bfe6a2f 015f2954 0c277ec3 17d1429a
022d6dba 37b8fadd b9869f16 31f1f5b5 f0118067 3d7ddea5 c86bc589 957956a9
002671c4 d9253002 d5ae906d 070e51b9 6647828b 51e21c41 4c1acc23 162cdd28
f5fb04d5 a7af106c c54ae92e 75329390 80fe2d5d 57a44902 7cd126b2 5c3cd340
df6ff97e 88e7e8ba 0ff8b727 21c1ba1e 8f4b8c22 243b1e3a cc274f31 2de218d9
40d5ed64 7dfb26d7 b304cf46 c99d0595 e0c99355 79cfe9e1 dbe187bb f7fb74ca
f6483e85 6a30c12c dc1503de 29361e55 076d2f9b 418115db 252b0c5b d3257f4e
87593037 394fbb1a da19ebc2 f3d4eca9 3e2b9691 9d70c617 38e8c8d6 7fdcc75e
f249cc01 43662793 f0058533 73748f6e 205e57be 8dbc1c83 2a0dc888 1eda42e2
24e1fd35 31fa909a e12d8acf f6d65a7c 7c183360 738f08f4 65725065 364b2e81
d286325f be5c0ca2 2231063e f7fb74ca 0d2d7fb5 a9276fb2 5ee619ce a9f82937
5025f676 909b4ca5 42321fd9 c9f1e08f 1e97c1c5
""".split())

SKIP_TOPICS = [
    "banking", "tax", "kyc", "market wrap", "fed rate", "manifesto", "ar-net",
    "poem", "verse", "song", "airdrop", "degen", "farming", "minting", "nft",
    "token launch", "presale", "rug pull", "horoscope", "astrology", "daily log",
    "day log", "worship", "prayer", "hydrogen", "观察日记", "人类世界",
]

INFRA_KEYWORDS = [
    "infrastructure", "deploy", "cloud", "payment", "autonomous", "wallet",
    "compute", "database", "state", "persist", "cost", "spend", "cron",
    "worker", "server", "provision", "infra", "memory", "storage", "api",
    "credential", "billing", "economic", "docker", "kubernetes", "postgres",
    "budget", "receipt", "migration", "x402", "mpp", "tempo", "stripe", "protocol",
]
