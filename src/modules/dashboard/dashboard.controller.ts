// src/modules/dashboard/dashboard.controller.ts
import { CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role, User } from '../../../generated/prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserScopedCacheInterceptor } from '../../common/interceptors/user-scoped-cache.interceptor';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@Roles(Role.VIEWER, Role.ANALYST, Role.ADMIN)
@UseInterceptors(UserScopedCacheInterceptor)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @CacheTTL(60) // 60 seconds cache
  @ApiOperation({
    summary: 'Full dashboard overview',
    description: 'Returns summary, category breakdown, monthly trends, and recent activity in one call.',
  })
  @ApiOkResponse({ description: 'Dashboard overview data' })
  async getOverview(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: Omit<User, 'password'>,
  ) {
    return this.dashboardService.getOverview(query, user);
  }

  @Get('summary')
  @CacheTTL(60)
  @ApiOperation({
    summary: 'Financial summary (totals)',
    description: 'Returns total income, total expenses, net balance, and transaction count.',
  })
  @ApiOkResponse({ description: 'Financial summary' })
  async getSummary(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: Omit<User, 'password'>,
  ) {
    return this.dashboardService.getSummary(query, user);
  }

  @Get('categories')
  @Roles(Role.ANALYST, Role.ADMIN)
  @CacheTTL(120)
  @ApiOperation({
    summary: 'Category-wise totals',
    description: 'ANALYST/ADMIN only. Returns income and expense totals grouped by category.',
  })
  @ApiOkResponse({ description: 'Category breakdown' })
  async getCategoryBreakdown(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: Omit<User, 'password'>,
  ) {
    return this.dashboardService.getCategoryBreakdown(query, user);
  }

  @Get('trends')
  @Roles(Role.ANALYST, Role.ADMIN)
  @CacheTTL(300)
  @ApiOperation({
    summary: 'Monthly income/expense trends',
    description: 'ANALYST/ADMIN only. Returns monthly income, expense, and net figures for the specified window.',
  })
  @ApiOkResponse({ description: 'Monthly trend data' })
  async getMonthlyTrends(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: Omit<User, 'password'>,
  ) {
    return this.dashboardService.getMonthlyTrends(query, user);
  }

  @Get('recent')
  @CacheTTL(30)
  @ApiOperation({
    summary: 'Recent transaction activity',
    description: 'Returns the 20 most recent transactions.',
  })
  @ApiOkResponse({ description: 'Recent activity' })
  async getRecentActivity(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: Omit<User, 'password'>,
  ) {
    return this.dashboardService.getRecentActivity(query, user);
  }
}
