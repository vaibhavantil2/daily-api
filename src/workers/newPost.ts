import shortid from 'shortid';
import { Connection, In } from 'typeorm';
import * as he from 'he';
import { Keyword, Post, PostKeyword, PostTag, Toc, User } from '../entity';
import { messageToJson, Worker } from './worker';

interface AddPostData {
  id: string;
  title: string;
  url: string;
  publicationId: string;
  publishedAt?: string | Date;
  createdAt?: Date;
  image?: string;
  ratio?: number;
  placeholder?: string;
  tags?: string[];
  siteTwitter?: string;
  creatorTwitter?: string;
  readTime?: number;
  canonicalUrl?: string;
  keywords?: string[];
  description?: string;
  toc?: Toc;
  summary?: string;
}

type Result = { postId: string; authorId?: string };

const addPost = async (con: Connection, data: AddPostData): Promise<void> => {
  await con.transaction(async (entityManager): Promise<Result> => {
    let keywords: string[] = null;
    if (data.keywords?.length > 0) {
      const synonymKeywords = await entityManager.getRepository(Keyword).find({
        where: {
          status: 'synonym',
          value: In(data.keywords),
        },
      });
      keywords = Array.from(
        new Set(
          data.keywords
            .map((keyword) => {
              const synonym = synonymKeywords.find(
                (synonym) => synonym.value === keyword && synonym.synonym,
              );
              return synonym?.synonym ?? keyword;
            })
            .filter((keyword) => !keyword.match(/^\d+$/)),
        ),
      );
    }
    const tags =
      keywords?.length > 0
        ? await entityManager.getRepository(Keyword).find({
            where: {
              status: 'allow',
              value: In(keywords),
            },
            order: { occurrences: 'DESC' },
          })
        : null;
    let authorId = null;
    if (data.creatorTwitter && typeof data.creatorTwitter === 'string') {
      const twitter = (
        data.creatorTwitter[0] === '@'
          ? data.creatorTwitter.substr(1)
          : data.creatorTwitter
      ).toLowerCase();
      const author = await entityManager
        .getRepository(User)
        .createQueryBuilder()
        .select('id')
        .where(
          `lower(twitter) = :twitter or (lower(username) = :twitter and username = 'addyosmani')`,
          {
            twitter,
          },
        )
        .getRawOne();
      if (author) {
        authorId = author.id;
      }
    }
    await entityManager.getRepository(Post).insert({
      id: data.id,
      shortId: data.id,
      publishedAt: data.publishedAt && new Date(data.publishedAt),
      createdAt: data.createdAt,
      sourceId: data.publicationId,
      url: data.url,
      title: data.title,
      image: data.image,
      ratio: data.ratio,
      placeholder: data.placeholder,
      score: Math.floor(data.createdAt.getTime() / (1000 * 60)),
      siteTwitter: data.siteTwitter,
      creatorTwitter: data.creatorTwitter,
      readTime: data.readTime,
      tagsStr: tags?.map((t) => t.value).join(',') || null,
      canonicalUrl: data.canonicalUrl,
      authorId,
      sentAnalyticsReport: !authorId,
      description: data.description,
      toc: data.toc,
      summary: data.summary,
    });
    if (data.tags?.length) {
      await entityManager.getRepository(PostTag).insert(
        data.tags.map((t) => ({
          tag: t,
          postId: data.id,
        })),
      );
    }
    if (keywords?.length) {
      await entityManager
        .createQueryBuilder()
        .insert()
        .into(Keyword)
        .values(keywords.map((keyword) => ({ value: keyword })))
        .onConflict(
          `("value") DO UPDATE SET occurrences = keyword.occurrences + 1`,
        )
        .execute();
      await entityManager.getRepository(PostKeyword).insert(
        keywords.map((keyword) => ({
          keyword,
          postId: data.id,
        })),
      );
    }
    return {
      postId: data.id,
      authorId,
    };
  });
};

const parseReadTime = (
  readTime: number | string | undefined,
): number | undefined => {
  if (!readTime) {
    return undefined;
  }
  if (typeof readTime == 'number') {
    return Math.floor(readTime);
  }
  return Math.floor(parseInt(readTime));
};

const worker: Worker = {
  subscription: 'add-posts-v2',
  handler: async (message, con, logger): Promise<void> => {
    const data: AddPostData = messageToJson(message);

    const p = await con
      .getRepository(Post)
      .createQueryBuilder()
      .select('id')
      .where(
        'url = :url or url = :canonicalUrl or "canonicalUrl" = :url or "canonicalUrl" = :canonicalUrl',
        { url: data.url, canonicalUrl: data.canonicalUrl },
      )
      .getRawOne();
    if (p) {
      logger.info(
        {
          post: data,
          messageId: message.messageId,
        },
        'post url already exists',
      );
      return;
    }
    if (data.creatorTwitter === '@NewGenDeveloper') {
      logger.info(
        {
          post: data,
          messageId: message.messageId,
        },
        'author is banned',
      );
      return;
    }

    if (!data.title) {
      return;
    }

    data.id = shortid.generate();
    data.title = he.decode(data.title);
    data.createdAt = new Date();
    data.readTime = parseReadTime(data.readTime);
    if (data.creatorTwitter === '' || data.creatorTwitter === '@') {
      data.creatorTwitter = null;
    }
    try {
      await addPost(con, data);
      logger.info(
        {
          post: data,
          messageId: message.messageId,
        },
        'added successfully post',
      );
    } catch (err) {
      logger.error(
        {
          post: data,
          messageId: message.messageId,
          err,
        },
        'failed to add post to db',
      );
      // Foreign / unique / null violation / index row size
      if (
        err?.code === '23502' ||
        err?.code === '23503' ||
        err?.code === '23505' ||
        err?.code === '54000'
      ) {
        return;
      }
      throw err;
    }
  },
};

export default worker;
