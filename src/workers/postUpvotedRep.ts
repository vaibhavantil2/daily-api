import { messageToJson, Worker } from './worker';
import { Post } from '../entity';
import { increaseReputation } from '../common';

interface Data {
  userId: string;
  postId: string;
}

const worker: Worker = {
  subscription: 'post-upvoted-rep',
  handler: async (message, con, logger): Promise<void> => {
    const data: Data = messageToJson(message);
    try {
      const post = await con.getRepository(Post).findOne(data.postId);
      if (post?.authorId && post?.authorId !== data.userId) {
        await increaseReputation(con, logger, post.authorId, 1);
        logger.info(
          {
            data,
            messageId: message.messageId,
          },
          'increased reputation due to post upvote',
        );
      }
    } catch (err) {
      logger.error(
        {
          data,
          messageId: message.messageId,
          err,
        },
        'failed to increase reputation due to post upvote',
      );
    }
  },
};

export default worker;
