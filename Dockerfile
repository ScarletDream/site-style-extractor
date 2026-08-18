FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY skills ./skills
COPY examples ./examples
COPY README.md README_EN.md SECURITY.md THIRD_PARTY_NOTICES.md LICENSE ./

USER pwuser
ENTRYPOINT ["node", "/app/bin/site-style.cjs"]
CMD ["--help"]
