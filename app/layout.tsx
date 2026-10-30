import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Поток — единый кабинет заказов',description:'Ozon и Wildberries: заказы, сборка и печать этикеток в одном приватном кабинете.',icons:{icon:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ru"><body>{children}</body></html>}
