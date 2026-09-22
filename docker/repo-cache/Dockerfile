# Local git mirrors of the registered repositories, served read-only over
# git:// to the containers the watcher spawns.
#
# Why this exists: Azure DevOps rate-limits per identity, 200 throughput units
# per sliding 5-minute window, and a full-history clone of one of the larger
# repositories costs 280-550 units on its own. Every spawned container used to
# clone its repository from Azure DevOps, so two reviews starting together
# throttled the whole identity — including the human whose PAT the pipeline
# uses. Measured over 48 hours, those clones were 94% of the budget.
#
# With this service, each repository is cloned from Azure DevOps once, kept
# current by a cheap incremental fetch every SYNC_INTERVAL_SEC, and every
# container clones from here over the internal network instead.
FROM alpine:3.20
RUN apk add --no-cache bash git git-daemon jq ca-certificates \
 && addgroup -g 10003 git && adduser -D -u 10003 -G git -h /home/git -s /sbin/nologin git \
 && mkdir -p /mirrors /config && chown git:git /mirrors
COPY --chmod=0755 entrypoint.sh sync.sh /usr/local/bin/
USER git
ENV HOME=/home/git MIRRORS_PATH=/config/mirrors.json MIRRORS_ROOT=/mirrors SYNC_INTERVAL_SEC=900
EXPOSE 9418
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
