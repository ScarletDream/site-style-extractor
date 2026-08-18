FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY skills ./skills
COPY examples ./examples
COPY README.md SECURITY.md LICENSE ./

USER pwuser
ENTRYPOINT ["node", "/app/bin/site-style.cjs"]
CMD ["--help"]
