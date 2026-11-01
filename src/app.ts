import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sourceSchema, scrape } from "./scraper";
import { AuthGuard, AuthRequest, admin } from "./security";
const connection = () => {
  const u = new URL(process.env.REDIS_URL!);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.slice(1) || 0),
    password: u.password || undefined,
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
  };
};
@Injectable()
export class Scraping implements OnModuleInit, OnModuleDestroy {
  readonly queue = new Queue("scrapes", {
    connection: connection(),
    prefix: process.env.QUEUE_PREFIX ?? "portfolio",
  });
  private worker?: Worker;
  onModuleInit() {
    this.worker = new Worker(
      "scrapes",
      async (job) => {
        const result = await scrape(job.data.source);
        await mkdir("results", { recursive: true });
        await writeFile(
          resolve("results", `${job.id}.json`),
          JSON.stringify(result, null, 2),
        );
        return result;
      },
      {
        connection: connection(),
        prefix: process.env.QUEUE_PREFIX ?? "portfolio",
        concurrency: 1,
        limiter: { max: 1, duration: 1000 },
      },
    );
    this.worker.on("error", (e) =>
      console.error(
        JSON.stringify({ event: "scraper-error", error: e.message }),
      ),
    );
    this.worker.on("failed", (job, error) =>
      console.error(
        JSON.stringify({
          event: "scrape-failed",
          jobId: job?.id,
          error: error.message,
        }),
      ),
    );
  }
  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
  }
}
@Controller("v1/scrapes")
@UseGuards(AuthGuard)
class Api {
  constructor(private readonly service: Scraping) {}
  @Post() async enqueue(@Body() body: unknown, @Req() req: AuthRequest) {
    admin(req.actor);
    const parsed = sourceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const job = await this.service.queue.add(
      "scrape",
      { source: parsed.data, tenantId: req.actor.tenantId },
      {
        jobId: randomUUID(),
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 7 * 86400 },
      },
    );
    return { id: job.id };
  }
  @Get(":id") async status(@Param("id") id: string, @Req() req: AuthRequest) {
    const job = await this.service.queue.getJob(id);
    if (!job || job.data.tenantId !== req.actor.tenantId)
      throw new BadRequestException("Job unavailable");
    return {
      id,
      state: await job.getState(),
      attempts: job.attemptsMade,
      result: job.returnvalue,
      error: job.failedReason || undefined,
    };
  }
  @Post("schedules") async schedule(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    admin(req.actor);
    const parsed = sourceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const id = `${req.actor.tenantId}-${parsed.data.name}`;
    await this.service.queue.upsertJobScheduler(
      id,
      { every: 3600000 },
      {
        name: "scheduled-scrape",
        data: { source: parsed.data, tenantId: req.actor.tenantId },
        opts: { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
      },
    );
    return { id, everyMs: 3600000 };
  }
}
@Controller("health")
class Health {
  constructor(private readonly service: Scraping) {}
  @Get("live") live() {
    return { status: "alive" };
  }
  @Get("ready") async ready() {
    await this.service.queue.getJobCounts();
    return { status: "ready" };
  }
}
@Module({ controllers: [Api, Health], providers: [Scraping, AuthGuard] })
export class AppModule {}
