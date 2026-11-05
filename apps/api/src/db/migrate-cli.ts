import { config } from '../config';
import { migrate } from './migrate';

migrate(config().DATABASE_URL)
  .then((a) => console.log(a.length ? `${a.length} migraciones aplicadas` : 'Base de datos al día'))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
